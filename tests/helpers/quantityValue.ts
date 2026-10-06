import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readQuantityData } from "../../src/core/quantityData";

type IndexQuantity = { name: string; unit: string; dimension?: string; coordinates?: { system: string; axes: { name: string; unit: string }[] }; data: { path: string } };

/**
 * The one number an oracle entry compares, read through the v0.2 reader whatever the adapter wrote: a scalar's value, the last
 * point of a series, or the value of a table with exactly one row.
 */
export function observedValue(q: IndexQuantity, projectRoot: string): number {
  const r = readQuantityData(readFileSync(join(projectRoot, q.data.path), "utf8"), q);
  if (!r.ok) throw new Error("data file of " + q.name + " refused: " + JSON.stringify(r.errors));
  const d = r.data;
  if (d.kind === "scalar") return d.value;
  if (d.kind === "series") return d.values[d.values.length - 1]!;
  if (d.rows.length !== 1) throw new Error("expected one row, got " + d.rows.length);
  const col = d.columns.findIndex((c) => c.role === "value");
  if (col < 0) throw new Error("the table has no value column");
  return d.rows[0]![col] as number;
}
