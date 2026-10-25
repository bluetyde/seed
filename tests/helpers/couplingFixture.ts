import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/core/canonical";
import { couplingRegistrationPin, saveCouplingHostConfig, validateCouplingHostConfig, type CouplingHostConfig } from "../../src/core/couplingHost";
import { writeHostJson } from "../../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../../src/core/oracle";
import { issueGrant, type Actor } from "../../src/core/policy";
import { createProject, openProject, saveProject } from "../../src/core/projectStore";

export const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
export const human: Actor = { kind: "human", name: "John" };
export const coupledDirs: string[] = [];

/** Real oracle evidence for a fake app: a git repository with one entry, and a passing set result, so that the gate sees an app in good standing. */
export async function appOracles(root: string, name: string, adapterId: string, over: { blocked?: boolean } = {}) {
  const repo = join(root, name + "-repo"), entries = join(repo, "entries");
  mkdirSync(entries, { recursive: true });
  const model = JSON.stringify({ name });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "q", value: 1, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = { schema: "seed.oracle/0.1", oracleId: name + "-one", entryVersion: 1, adapter: adapterId, adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
    source: { kind: "hand", text: "test", check: "fixture" }, coverage: { quantities: ["q"], domain: "fixture" }, toleranceHash: sha256Hex(canonicalJson({ expected, tolerance })) };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: adapterId, version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...(over.blocked ? { quantity: "q", value: 2, unit: "1" } : expected) }) });
  const evidence = join(root, name + "-evidence.json");
  writeHostJson(evidence, result);
  return { adapter: { id: adapterId, version: "0.1.0" }, oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: result.pins };
}

/** A project with an OpenMC project file and a FEED case, two fake apps in good standing, and the lumped loop registered (kind lumped-power-temperature, no runner or transfer command). */
export async function couplingFixture() {
  const root = mkdtempSync(join(tmpdir(), "seed coupling fixture "));
  coupledDirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  expect(createProject(project, { name: "Coupling fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const om = JSON.stringify({ materials: [{ id: "m_uo2" }] }, null, 2) + "\n", fe = JSON.stringify({ caseId: "pin" }, null, 2) + "\n";
  writeFileSync(join(project, "models/pin.openmc-studio.json"), om);
  writeFileSync(join(project, "models/pin.case.json"), fe);
  const p = openProject(project);
  if (!p.ok) throw Error("project");
  const manifest = structuredClone(p.value.manifest) as Record<string, any>;
  manifest.artifacts = [
    { id: "om-project", app: "openmc", path: "models/pin.openmc-studio.json", format: "openmc-studio.project", formatVersion: "1", revision: { hash: sha256Hex(om), counter: 1 } },
    { id: "pin-case", app: "feed", path: "models/pin.case.json", format: "feed.case", formatVersion: "1", revision: { hash: sha256Hex(fe), counter: 1 } },
  ];
  expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);
  const apps = { openmc: await appOracles(root, "openmc", "openmc"), feed: await appOracles(root, "feed", "feed") };
  const inputs = { openmc: [{ artifact: "om-project", revision: sha256Hex(om) }], feed: [{ artifact: "pin-case", revision: sha256Hex(fe) }] };
  const config = (actor: Actor, grants: unknown[] = [], edit: (c: CouplingHostConfig) => void = () => {}): CouplingHostConfig => {
    const c = built(actor, grants);
    edit(c);
    return c;
  };
  const built = (actor: Actor, grants: unknown[]): CouplingHostConfig => ({
    schema: "seed.coupling-host/0.1", projectRoot: project, stateRoot: state, actor,
    study: { studyId: "study-1", tier: "A2", budget: { maxWallSeconds: 900, maxCores: 1, maxMemoryMB: 4096, maxDiskMB: 1024, maxCases: 100 }, parameters: [] },
    grants: grants as never, apps,
    loops: {
      lumped: {
        purpose: "plumbing-test", kind: "lumped-power-temperature", apps: ["openmc", "feed"], inputs,
        definition: { exchanged: [{ id: "temperature_fuel_mean", tolerance: 1e-3, min: 250, max: 2500 }], maxPasses: 6, relaxation: 1, consecutive: 2 },
        start: { temperature_fuel_mean: 900 },
        options: {
          openmc: { app: "openmc", artifact: "om-project", material: "m_uo2", quantity: "Pin mesh:heating", threads: 1 },
          feed: { app: "feed", artifact: "pin-case", pin: "1,1", frame: "openmc-model", applyTo: "s1", binCount: 4, totalPowerW: 250, slices: [{ id: "s1", z: { min: -0.0063, max: 0.0063 } }] },
        },
      },
    },
  });
  const grant = (edit: (c: CouplingHostConfig) => void = () => {}) => {
    const validated = validateCouplingHostConfig(JSON.parse(JSON.stringify(config(agent, [], edit))));
    const g = issueGrant(human, { grantId: "g-1", studyId: "study-1", actor: { kind: agent.kind, name: agent.name }, operation: "enable_coupling", inputRevisions: [...inputs.openmc, ...inputs.feed, couplingRegistrationPin("lumped", validated.loops.lumped!)], issuedAt: "2026-10-25T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" } as never);
    if (!g.ok) throw new Error(JSON.stringify(g.errors));
    return g.grant;
  };
  const file = join(root, "coupling-host.json");
  return { root, project, state, file, config, grant, inputs, write: (actor: Actor, grants: unknown[] = [], edit: (c: CouplingHostConfig) => void = () => {}) => saveCouplingHostConfig(file, config(actor, grants, edit)) };
}
