const crypto = require("crypto");

// Plain code-unit order, the same on every machine and locale; localeCompare would change the committed file between machines.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Parses markdown TODO checkboxes into structured box records.
 * Matches lines: ^\s*(?:[-*]|\d+\.)\s+\[( |x|~)\]\s+(.*)$
 */
function parseBoxes(text) {
  const lines = text.split(/\r?\n/);
  const boxes = [];
  const BOX_RE = /^\s*(?:[-*]|\d+\.)\s+\[( |x|~)\]\s+(.*)$/;
  const ID_TOKEN_RE = /^\{(R-[A-Z0-9]+-\d{2,3})( manual)?\}(?:\s*(.*))?$/;
  const seenIds = new Map();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const match = BOX_RE.exec(lines[i]);
    if (!match) continue;

    const state = match[1];
    const captured = match[2];

    const idMatch = ID_TOKEN_RE.exec(captured);
    let id = null;
    let boxText = "";
    let manual = false;

    if (idMatch) {
      id = idMatch[1];
      manual = Boolean(idMatch[2]);
      boxText = (idMatch[3] || "").trim();
      if (seenIds.has(id)) {
        const firstLine = seenIds.get(id);
        throw new Error(`duplicate requirement id ${id} (lines ${firstLine} and ${lineNum})`);
      }
      seenIds.set(id, lineNum);
    } else {
      boxText = captured.trim();
    }

    boxes.push({
      line: lineNum,
      state,
      id,
      text: boxText,
      ...(manual ? { manual: true } : {}),
    });
  }

  return boxes;
}

// Titles built from templates or .each are not detected (documented limit, not an error).
function scanTests(files) {
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tests = [];

  const TEST_RE = /^(\s*)(?:it|test)(?:\.(?:skip|only|todo))?\s*\(\s*(["'\x60])(.*?)\2/;
  const DESCRIBE_RE = /^(\s*)describe(?:\.(?:skip|only|todo))?\s*\(\s*(["'\x60])(.*?)\2/;
  const ID_RE = /\[(R-[A-Z0-9]+-\d{2,3})\]/g;

  function countIndent(ws) {
    let indent = 0;
    for (let i = 0; i < ws.length; i++) {
      if (ws[i] === "\t") indent += 4;
      else if (ws[i] === " ") indent += 1;
    }
    return indent;
  }

  function extractIds(title) {
    return [...title.matchAll(ID_RE)].map((m) => m[1]);
  }

  for (const fileObj of sortedFiles) {
    const lines = fileObj.text.split(/\r?\n/);
    const describes = []; // { indent, ids, parentIndex }

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const lineText = lines[i];

      const descMatch = DESCRIBE_RE.exec(lineText);
      if (descMatch) {
        const indent = countIndent(descMatch[1]);
        const title = descMatch[3];
        const ids = extractIds(title);

        let parentIndex = null;
        for (let j = describes.length - 1; j >= 0; j--) {
          if (describes[j].indent < indent) {
            parentIndex = j;
            break;
          }
        }
        describes.push({ indent, ids, parentIndex });
        continue;
      }

      const testMatch = TEST_RE.exec(lineText);
      if (testMatch) {
        const indent = countIndent(testMatch[1]);
        const title = testMatch[3];
        const ownIds = extractIds(title);

        const allIds = [...ownIds];
        let parentIndex = null;
        for (let j = describes.length - 1; j >= 0; j--) {
          if (describes[j].indent < indent) {
            parentIndex = j;
            break;
          }
        }

        let cur = parentIndex;
        while (cur !== null) {
          allIds.push(...describes[cur].ids);
          cur = describes[cur].parentIndex;
        }

        const uniqueSortedIds = Array.from(new Set(allIds)).sort();
        tests.push({
          file: fileObj.path,
          line: lineNum,
          title,
          ids: uniqueSortedIds,
        });
      }
    }
  }

  return { tests, total: tests.length };
}

/**
 * File-level tags: a line `// @covers R-X-01, R-X-02` anywhere in a test file says every test of the file is evidence for those requirements.
 * Returns one record per file that has at least one tag, with the number of tests found in it.
 */
function scanFileTags(files, tests) {
  const COVERS_RE = /^\s*\/\/\s*@covers\s+(.+)$/;
  const ID_RE = /R-[A-Z0-9]+-\d{2,3}/g;
  const counts = new Map();
  for (const t of tests) counts.set(t.file, (counts.get(t.file) || 0) + 1);
  const out = [];
  for (const f of [...files].sort((a, b) => byCodeUnit(a.path, b.path))) {
    const ids = [];
    for (const line of f.text.split(/\r?\n/)) {
      const m = COVERS_RE.exec(line);
      if (m) ids.push(...(m[1].match(ID_RE) || []));
    }
    if (ids.length > 0) out.push({ file: f.path, ids: Array.from(new Set(ids)).sort(byCodeUnit), tests: counts.get(f.path) || 0 });
  }
  return out;
}

/**
 * Builds the traceability matrix matching requirements to tests.
 * `fileTags` (from scanFileTags) are optional; without them the result is what it was before file tags existed.
 */
function buildMatrix(boxes, tests, fileTags = []) {
  const rows = [];
  const boxesWithId = boxes.filter((b) => b.id !== null);

  for (const box of boxesWithId) {
    const matchingTests = tests
      .filter((t) => t.ids.includes(box.id))
      .sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line)
      .map((t) => ({ file: t.file, line: t.line, title: t.title }));

    const matchingFiles = fileTags
      .filter((f) => f.ids.includes(box.id))
      .map((f) => ({ file: f.file, tests: f.tests }));

    rows.push({
      id: box.id,
      state: box.state,
      text: box.text,
      tests: matchingTests,
      ...(matchingFiles.length > 0 ? { files: matchingFiles } : {}),
      ...(box.manual ? { manual: true } : {}),
    });
  }

  const noEvidence = rows.filter(
    (r) => (r.state === "x" || r.state === "~") && r.tests.length === 0 && !r.files && !r.manual
  );

  const knownIds = new Set(rows.map((r) => r.id));
  const unknownTests = [];

  for (const t of tests) {
    const unknownIds = t.ids.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      unknownTests.push({
        file: t.file,
        line: t.line,
        title: t.title,
        ids: unknownIds,
        unknownIds,
      });
    }
  }

  const unknownFiles = [];
  for (const f of fileTags) {
    const unknownIds = f.ids.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) unknownFiles.push({ file: f.file, ids: unknownIds });
  }

  const taggedFiles = new Set(fileTags.map((f) => f.file));
  const tagged = tests.filter((t) => t.ids.length > 0 || taggedFiles.has(t.file)).length;
  const untagged = tests.length - tagged;
  const total = tagged + untagged;
  const requirements = rows.length;

  return {
    rows,
    noEvidence,
    unknownTests,
    ...(unknownFiles.length > 0 ? { unknownFiles } : {}),
    tagged,
    untagged,
    total,
    requirements,
  };
}

/**
 * Calculates SHA256 hex hash of relevant requirement boxes and test entries.
 */
function sourceHash(boxes, tests, fileTags = []) {
  const boxesPayload = boxes
    .filter((b) => b.id !== null)
    .map((b) => (b.manual ? [b.id, b.state, b.text, "manual"] : [b.id, b.state, b.text]));

  const sortedTests = [...tests].sort(
    (a, b) => byCodeUnit(a.file, b.file) || a.line - b.line
  );
  const testsPayload = sortedTests.map((t) => [t.file, t.title, t.ids]);

  const payload = JSON.stringify({
    boxes: boxesPayload,
    tests: testsPayload,
    ...(fileTags.length > 0 ? { files: fileTags.map((f) => [f.file, f.ids, f.tests]) } : {}),
  });

  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Renders the traceability matrix markdown document.
 */
function render(matrix, hash) {
  const STATE_WORDS = {
    " ": "open",
    "x": "done",
    "~": "partial",
  };

  const lines = [
    "# Requirement to test traceability",
    "",
    "Generated by scripts/trace-matrix.cjs from TODO.md and tests/**/*.test.ts. Do not edit by hand; run `node scripts/trace-matrix.cjs` to regenerate.",
    "",
    `- requirements with an ID: ${matrix.requirements}`,
    `- tests found: ${matrix.total} (tagged ${matrix.tagged}, untagged ${matrix.untagged})`,
    `- requirements with no test evidence: ${matrix.noEvidence.length}`,
    `- tests naming an unknown requirement: ${matrix.unknownTests.length}`,
    `- source hash: ${hash}`,
    "",
    "## Matrix",
    "",
    "| ID | State | Requirement | Tests |",
    "|---|---|---|---|",
  ];

  if (matrix.rows.length === 0) {
    lines.push("| none | | | |");
  } else {
    for (const row of matrix.rows) {
      const stateWord = STATE_WORDS[row.state] || row.state;
      let reqText = row.text.length > 100 ? row.text.slice(0, 100) + "..." : row.text;
      reqText = reqText.replace(/\|/g, "\\|");

      const cells = row.tests.map((t) => {
        let title = t.title.length > 80 ? t.title.slice(0, 80) + "..." : t.title;
        title = title.replace(/\|/g, "\\|");
        return `${t.file}:${t.line} "${title}"`;
      });
      for (const f of row.files || []) cells.push(`${f.file} (all ${f.tests} tests of the file)`);
      if (row.manual) cells.push("manual: documentation or a hand check, not a test");
      const testsCell = cells.length === 0 ? "none" : cells.join("<br>");

      lines.push(`| ${row.id} | ${stateWord} | ${reqText} | ${testsCell} |`);
    }
  }

  lines.push("");
  lines.push("## Requirements with no test evidence");
  lines.push("");

  if (matrix.noEvidence.length === 0) {
    lines.push("none");
  } else {
    for (const row of matrix.noEvidence) {
      const stateWord = STATE_WORDS[row.state] || row.state;
      lines.push(`- ${row.id} (${stateWord}): ${row.text}`);
    }
  }

  lines.push("");
  lines.push("## Tests naming an unknown requirement");
  lines.push("");

  const unknownFiles = matrix.unknownFiles || [];
  if (matrix.unknownTests.length === 0 && unknownFiles.length === 0) {
    lines.push("none");
  } else {
    for (const t of matrix.unknownTests) {
      lines.push(`- ${t.file}:${t.line} "${t.title}" names ${t.ids.join(", ")}`);
    }
    for (const f of unknownFiles) {
      lines.push(`- ${f.file} (file tag) names ${f.ids.join(", ")}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

module.exports = {
  parseBoxes,
  scanTests,
  scanFileTags,
  buildMatrix,
  sourceHash,
  render,
};
