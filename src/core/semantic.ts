import { canonicalJson, sha256Hex } from "./canonical";
import { validate, type TypedError } from "./validate";

export function checkProject(manifest: unknown): TypedError[] {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "",
        message: "expected object",
        source: "seed"
      }
    ];
  }

  const record = manifest as Record<string, unknown>;
  const errors: TypedError[] = [];

  const artifacts = record.artifacts;
  if (Array.isArray(artifacts)) {
    const seenArtifactIds = new Set<string>();
    for (let i = 0; i < artifacts.length; i++) {
      const art = artifacts[i];
      if (art && typeof art === "object" && !Array.isArray(art)) {
        const id = (art as Record<string, unknown>).id;
        if (typeof id === "string") {
          if (seenArtifactIds.has(id)) {
            errors.push({
              code: "E_SCHEMA_INVALID",
              field: `/artifacts/${i}/id`,
              message: "duplicate artifact id",
              source: "seed"
            });
          } else {
            seenArtifactIds.add(id);
          }
        }
      }
    }
  }

  const materials = record.materials;
  if (Array.isArray(materials)) {
    const seenMaterialIds = new Set<string>();
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      if (mat && typeof mat === "object" && !Array.isArray(mat)) {
        const id = (mat as Record<string, unknown>).id;
        if (typeof id === "string") {
          if (seenMaterialIds.has(id)) {
            errors.push({
              code: "E_SCHEMA_INVALID",
              field: `/materials/${i}/id`,
              message: "duplicate material id",
              source: "seed"
            });
          } else {
            seenMaterialIds.add(id);
          }
        }
      }
    }
  }

  return errors;
}

export function checkResultsIndex(index: unknown): TypedError[] {
  if (index === null || typeof index !== "object" || Array.isArray(index)) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "",
        message: "expected object",
        source: "seed"
      }
    ];
  }

  const record = index as Record<string, unknown>;
  const errors: TypedError[] = [];
  const runId = record.runId;

  const quantities = record.quantities;
  if (Array.isArray(quantities)) {
    const seenNames = new Set<string>();
    for (let i = 0; i < quantities.length; i++) {
      const q = quantities[i];
      if (q && typeof q === "object" && !Array.isArray(q)) {
        const qRecord = q as Record<string, unknown>;
        const prov = qRecord.provenance as Record<string, unknown> | undefined;
        if (prov && typeof prov === "object" && prov.runId !== undefined) {
          if (prov.runId !== runId) {
            errors.push({
              code: "E_SCHEMA_INVALID",
              field: `/quantities/${i}/provenance/runId`,
              message: "provenance runId does not match index runId",
              source: "seed"
            });
          }
        }

        const name = qRecord.name;
        if (typeof name === "string") {
          if (seenNames.has(name)) {
            errors.push({
              code: "E_SCHEMA_INVALID",
              field: `/quantities/${i}/name`,
              message: "duplicate quantity name",
              source: "seed"
            });
          } else {
            seenNames.add(name);
          }
        }
      }
    }
  }

  return errors;
}

export function checkOracleHash(entry: unknown): TypedError[] {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "",
        message: "expected object",
        source: "seed"
      }
    ];
  }

  const record = entry as Record<string, unknown>;
  const expected = record.expected;
  const tolerance = record.tolerance;

  const hasValue =
    typeof expected === "object" && expected !== null && "value" in (expected as Record<string, unknown>);

  if (hasValue && (tolerance === undefined || tolerance === null)) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "/tolerance",
        message: "tolerance is required when expected has a value",
        source: "seed"
      }
    ];
  }

  const pinObj = {
    expected: expected ?? null,
    tolerance: tolerance ?? null
  };

  let computedHash = "";
  try {
    computedHash = sha256Hex(canonicalJson(pinObj));
  } catch {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "/toleranceHash",
        message: "failed to compute canonical hash",
        source: "seed"
      }
    ];
  }

  if (record.toleranceHash !== computedHash) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "/toleranceHash",
        message: "toleranceHash does not match computed hash",
        source: "seed"
      }
    ];
  }

  return [];
}

export function verifyStudyLog(lines: string[]): TypedError[] {
  const errors: TypedError[] = [];

  if (lines.length === 0) {
    return [
      {
        code: "E_SCHEMA_INVALID",
        field: "line/1",
        message: "first line must be a header",
        source: "seed"
      }
    ];
  }

  const parsedLines: Array<Record<string, unknown> | null> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i] ?? "";
    try {
      const parsed = JSON.parse(lineStr);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: "",
          message: `line ${i + 1} is not a valid JSON object`,
          source: "seed"
        });
        parsedLines.push(null);
      } else {
        parsedLines.push(parsed as Record<string, unknown>);
      }
    } catch {
      errors.push({
        code: "E_SCHEMA_INVALID",
        field: "",
        message: `line ${i + 1} is not valid JSON`,
        source: "seed"
      });
      parsedLines.push(null);
    }
  }

  // If any line was invalid JSON, we cannot perform full structural verification
  if (errors.length > 0) {
    return errors;
  }

  // Validate each parsed line against schema
  for (let i = 0; i < parsedLines.length; i++) {
    const lineNum = i + 1;
    const p = parsedLines[i];
    const valResult = validate("study", p);
    if (!valResult.ok) {
      for (const err of valResult.errors) {
        const fieldSuffix = err.field.startsWith("/") ? err.field : err.field ? `/${err.field}` : "";
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}${fieldSuffix}`,
          message: err.message,
          source: "seed"
        });
      }
    }
  }

  // Sequence, ordering, and header/conclusion checks
  const first = parsedLines[0];
  if (first && first.type !== "header") {
    errors.push({
      code: "E_SCHEMA_INVALID",
      field: "line/1",
      message: "first line must be a header",
      source: "seed"
    });
  }
  if (first && first.seq !== 0) {
    errors.push({
      code: "E_SCHEMA_INVALID",
      field: "line/1",
      message: "header seq must be 0",
      source: "seed"
    });
  }

  let conclusionCount = 0;
  for (let i = 0; i < parsedLines.length; i++) {
    const lineNum = i + 1;
    const p = parsedLines[i];
    if (!p) continue;

    if (i > 0) {
      const prev = parsedLines[i - 1];
      if (typeof p.seq === "number" && prev && typeof prev.seq === "number") {
        if (p.seq !== prev.seq + 1) {
          errors.push({
            code: "E_SCHEMA_INVALID",
            field: `line/${lineNum}`,
            message: "seq must increase by 1",
            source: "seed"
          });
        }
      }
    }

    if (p.type === "conclusion") {
      conclusionCount++;
      if (conclusionCount > 1) {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}`,
          message: "at most one conclusion",
          source: "seed"
        });
      } else if (i !== parsedLines.length - 1) {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}`,
          message: "conclusion must be the last line",
          source: "seed"
        });
      }
    }
  }

  // Chain verification
  const anyHasHash = parsedLines.some(
    (p) => p && (p.hash !== undefined || p.prev !== undefined)
  );

  if (anyHasHash) {
    for (let i = 0; i < parsedLines.length; i++) {
      const lineNum = i + 1;
      const p = parsedLines[i];
      if (!p) continue;

      const hasHash = p.hash !== undefined;
      const hasPrev = p.prev !== undefined;

      if (!hasHash && !hasPrev) {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}`,
          message: "every line must carry hash and prev when any does",
          source: "seed"
        });
        continue;
      }

      if (!hasHash || !hasPrev) {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}`,
          message: "hash and prev must appear together",
          source: "seed"
        });
        continue;
      }

      // Check prev
      if (i === 0) {
        if (p.prev !== null) {
          errors.push({
            code: "E_SCHEMA_INVALID",
            field: `line/${lineNum}`,
            message: "prev does not match the previous hash",
            source: "seed"
          });
        }
      } else {
        const prevLine = parsedLines[i - 1];
        if (prevLine && prevLine.hash !== undefined) {
          if (p.prev !== prevLine.hash) {
            errors.push({
              code: "E_SCHEMA_INVALID",
              field: `line/${lineNum}`,
              message: "prev does not match the previous hash",
              source: "seed"
            });
          }
        }
      }

      // Check hash
      const { hash: _origHash, ...rest } = p;
      try {
        const canonical = canonicalJson(rest);
        const expectedHash = sha256Hex(canonical);
        if (p.hash !== expectedHash) {
          errors.push({
            code: "E_SCHEMA_INVALID",
            field: `line/${lineNum}`,
            message: "hash does not match",
            source: "seed"
          });
        }
      } catch {
        errors.push({
          code: "E_SCHEMA_INVALID",
          field: `line/${lineNum}`,
          message: "hash does not match",
          source: "seed"
        });
      }
    }
  }

  return errors;
}

/**
 * A results index must belong to the run snapshot it is attached to: its inputHashes equal the record's inputs
 * (as a set of path + sha256) and every quantity's provenance.inputRevisions names only hashes of those inputs.
 */
export function checkResultsAgainstRecord(index: unknown, record: unknown): TypedError[] {
  const errors: TypedError[] = [];
  const idx = index as Record<string, unknown> | null;
  const rec = record as Record<string, unknown> | null;
  if (idx === null || typeof idx !== "object" || rec === null || typeof rec !== "object") {
    return [{ code: "E_SCHEMA_INVALID", field: "", message: "expected objects", source: "seed" }];
  }
  type InputRef = { path: string; sha256: string };
  const keyOf = (i: InputRef): string => i.path + "\u0000" + i.sha256;
  const recordInputs = Array.isArray(rec.inputs) ? (rec.inputs as InputRef[]) : [];
  const indexInputs = Array.isArray(idx.inputHashes) ? (idx.inputHashes as InputRef[]) : [];
  const a = indexInputs.map(keyOf).sort();
  const b = recordInputs.map(keyOf).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
    errors.push({
      code: "E_SCHEMA_INVALID",
      field: "/inputHashes",
      message: "results-index inputHashes do not match the run's input snapshot",
      source: "seed"
    });
  }
  const snapshotHashes = new Set(recordInputs.map((i) => i.sha256));
  const quantities = Array.isArray(idx.quantities) ? (idx.quantities as Record<string, unknown>[]) : [];
  quantities.forEach((q, qi) => {
    const prov = q.provenance as { inputRevisions?: unknown } | undefined;
    const revisions = Array.isArray(prov?.inputRevisions) ? (prov?.inputRevisions as string[]) : [];
    if (!revisions.every((h) => snapshotHashes.has(h))) {
      errors.push({
        code: "E_SCHEMA_INVALID",
        field: `/quantities/${qi}/provenance/inputRevisions`,
        message: "quantity provenance names an input revision that is not in the run's snapshot",
        source: "seed"
      });
    }
  });
  return errors;
}
