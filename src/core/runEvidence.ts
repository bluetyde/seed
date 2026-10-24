import { readFileSync, realpathSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./canonical";
import { inside, regularFile, safeChild } from "./hostFiles";
import { readQuantityData } from "./quantityData";
import type { ReplayRun } from "./replay";
import { RESULTS_INDEX_SCHEMAS, validate } from "./validate";

/**
 * Everything the comparison needs about one run, proven from the saved files: each output is read and checked against the hash in the run record,
 * the results index is validated and bound to the record, and each quantity's data is read with the shared reader. A completed run only.
 */
export function loadRunEvidence(projectRoot: string, runRoot: string, record: any): ReplayRun {
  const checked = (path: string, hash: string): Buffer => {
    const abs = safeChild(projectRoot, path);
    if (!inside(runRoot, realpathSync(abs))) throw Error("an output leaves its run folder");
    regularFile(abs);
    const bytes = readFileSync(abs);
    if (sha256Hex(bytes) !== hash) throw Error("a saved output no longer matches its hash");
    return bytes;
  };
  const run: ReplayRun = {
    runId: record.runId,
    state: record.state,
    adapter: record.adapter,
    ...(record.engine ? { engine: record.engine } : {}),
    ...(record.dataLibrary ? { dataLibrary: record.dataLibrary } : {}),
    ...(record.seed !== undefined ? { seed: record.seed } : {}),
    inputs: record.inputs.map((i: any) => ({ path: i.path, sha256: i.sha256 })),
    settings: record.settings,
    quantities: [],
  };
  if (record.state !== "completed") return run;
  const indexes: any[] = [];
  for (const output of record.outputs) {
    const bytes = checked(output.path, output.sha256);
    try {
      const doc = JSON.parse(bytes.toString());
      if (RESULTS_INDEX_SCHEMAS.includes(doc.schema)) indexes.push(doc);
    } catch {
      /* a quantity file in another format */
    }
  }
  if (indexes.length !== 1) throw Error("a completed run must hold exactly one results index");
  const index = indexes[0];
  if (!validate("results-index", index).ok || canonicalJson(index.adapter) !== canonicalJson(record.adapter)) throw Error("the results index does not belong to this run");
  for (const q of index.quantities) {
    if (!record.outputs.some((o: any) => o.path === q.data.path && o.sha256 === q.data.sha256)) throw Error("a quantity is not bound to the run's outputs");
    const read = readQuantityData(JSON.parse(checked(q.data.path, q.data.sha256).toString()), { name: q.name, unit: q.unit, ...(q.dimension ? { dimension: q.dimension } : {}), ...(q.coordinates ? { coordinates: q.coordinates } : {}) });
    if (!read.ok) throw Error(`the data of ${q.name} cannot be read: ${read.errors.map((e) => e.message).join("; ")}`);
    // an uncertainty the index declares for a scalar whose data file gives none is the number's own noise; it is carried, never invented, never taken from a different kind
    let data = read.data;
    const u = q.uncertainty;
    if (data.kind === "scalar" && data.std === undefined && u && u.kind === "statistical" && typeof u.value === "number" && (u.unit === undefined || u.unit === q.unit)) data = { ...data, std: u.value };
    run.quantities.push({ name: q.name, unit: q.unit, normalization: q.normalization, data });
  }
  return run;
}
