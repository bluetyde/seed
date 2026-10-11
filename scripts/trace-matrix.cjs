#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  parseBoxes,
  scanTests,
  scanFileTags,
  buildMatrix,
  sourceHash,
  render,
} = require("./lib/traceability.cjs");

// Parse command line arguments
const args = process.argv.slice(2);
let rootArg = null;
let check = false;
let outArg = null;
let resultsArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--root") {
    if (i + 1 >= args.length) {
      console.error("missing argument for --root");
      process.exit(2);
    }
    rootArg = args[++i];
  } else if (arg === "--check") {
    check = true;
  } else if (arg === "--out") {
    if (i + 1 >= args.length) {
      console.error("missing argument for --out");
      process.exit(2);
    }
    outArg = args[++i];
  } else if (arg === "--results") {
    if (i + 1 >= args.length) {
      console.error("missing argument for --results");
      process.exit(2);
    }
    resultsArg = args[++i];
  } else {
    console.error(`unknown option: ${arg}`);
    process.exit(2);
  }
}

const root = path.resolve(rootArg || path.join(__dirname, ".."));

// Validate results file early if specified
let report = null;
if (resultsArg) {
  const resultsPath = path.resolve(resultsArg);
  try {
    const raw = fs.readFileSync(resultsPath, "utf8");
    report = JSON.parse(raw);
    if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
      throw new Error("missing testResults array");
    }
  } catch (err) {
    console.error(`unreadable or invalid results file: ${err.message}`);
    process.exit(2);
  }
}

// Read TODO.md
const todoPath = path.join(root, "TODO.md");
let todoText;
try {
  todoText = fs.readFileSync(todoPath, "utf8");
} catch (err) {
  console.error(`cannot read TODO.md at ${todoPath}: ${err.message}`);
  process.exit(2);
}

// Scan tests recursively under <root>/tests/
function findTestFiles(dir, rootDir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`cannot read directory ${dir}: ${err.message}`);
    process.exit(2);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "fixtures") continue;
      results.push(...findTestFiles(path.join(dir, entry.name), rootDir));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
      results.push({ fullPath, path: relPath });
    }
  }
  return results;
}

const testsDir = path.join(root, "tests");
const testFileEntries = findTestFiles(testsDir, root);
testFileEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const files = [];
for (const entry of testFileEntries) {
  try {
    const content = fs.readFileSync(entry.fullPath, "utf8");
    files.push({ path: entry.path, text: content });
  } catch (err) {
    console.error(`cannot read test file ${entry.fullPath}: ${err.message}`);
    process.exit(2);
  }
}

let boxes;
try {
  boxes = parseBoxes(todoText);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const { tests, total } = scanTests(files);
const fileTags = scanFileTags(files, tests);
const matrix = buildMatrix(boxes, tests, fileTags);
const hash = sourceHash(boxes, tests, fileTags);
const rendered = render(matrix, hash);

const outFile = outArg ? path.resolve(root, outArg) : path.join(root, "docs", "TRACEABILITY.md");
const displayPath = path.relative(root, outFile).split(path.sep).join("/") || outFile;

function printResults() {
  if (!report) return;
  const allAssertions = [];
  for (const tr of report.testResults) {
    const trPath = typeof tr.name === "string" ? tr.name.split(path.sep).join("/").replace(/\\/g, "/") : "";
    if (Array.isArray(tr.assertionResults)) {
      for (const ar of tr.assertionResults) {
        if (ar && typeof ar.fullName === "string") {
          allAssertions.push({ ...ar, filePath: trPath });
        }
      }
    }
  }
  for (const row of matrix.rows) {
    const id = row.id;
    const needle = `[${id}]`;
    const taggedFiles = (row.files || []).map((f) => f.file);
    let passed = 0;
    let failed = 0;
    let other = 0;
    for (const ar of allAssertions) {
      // a test is evidence by its title, or because its whole file is tagged with the requirement
      if (ar.fullName.includes(needle) || taggedFiles.some((f) => ar.filePath === f || ar.filePath.endsWith("/" + f))) {
        if (ar.status === "passed") passed++;
        else if (ar.status === "failed") failed++;
        else other++;
      }
    }
    console.log(`${id}: ${passed} passed, ${failed} failed, ${other} other`);
  }
}

if (check) {
  if (!fs.existsSync(outFile)) {
    console.log("traceability matrix is out of date: run node scripts/trace-matrix.cjs");
    process.exit(1);
  }
  let existing;
  try {
    existing = fs.readFileSync(outFile, "utf8");
  } catch (err) {
    console.error(`cannot read ${outFile}: ${err.message}`);
    process.exit(2);
  }
  if (existing !== rendered) {
    console.log("traceability matrix is out of date: run node scripts/trace-matrix.cjs");
    process.exit(1);
  }
  console.log("traceability matrix is current");
  printResults();
  process.exit(0);
} else {
  try {
    fs.writeFileSync(outFile, rendered, "utf8");
  } catch (err) {
    console.error(`cannot write ${outFile}: ${err.message}`);
    process.exit(2);
  }
  console.log(`wrote ${displayPath}: ${matrix.requirements} requirements, ${matrix.total} tests`);
  printResults();
  process.exit(0);
}
