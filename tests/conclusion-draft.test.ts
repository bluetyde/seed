// @covers R-REP-03
import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { proposeConclusion } from "../src/core/conclusionDraft";
import { runCli } from "../src/cli/seed";

const reportId = "a".repeat(32);
const claim = { text: "Draft only", runs: ["r-test"], oracles: [] };
it.each([
  null, {}, { reportId: "../report.html", claims: [claim] },
  { reportId, claims: [claim], acceptedBy: "human" },
  { reportId, claims: [claim], time: "2026-10-04" },
  { reportId, claims: [] }, { reportId, claims: Array(21).fill(claim) },
  { reportId, claims: [{ ...claim, text: " " }] },
  { reportId, claims: [{ ...claim, text: "x".repeat(2001) }] },
  { reportId, claims: [{ ...claim, runs: [] }] },
  { reportId, claims: [{ ...claim, runs: ["r-test", "r-test"] }] },
  { reportId, claims: [{ ...claim, oracles: [123] }] },
  { reportId, claims: [{ ...claim, accepted: true }] },
])("refuses malformed or authority-bearing proposal %# before host access", async request => {
  const reply = await proposeConclusion("missing-host-file", request);
  expect(reply).toMatchObject({ ok: false });
  if (!reply.ok) expect(reply.errors[0].message).not.toContain("ENOENT");
});
it("offers proposal but no CLI acceptance verb", async () => {
  expect(await runCli(["accept-conclusion"], Readable.from(["{}"]), "missing-host-file")).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_VERB_UNKNOWN" }] } });
  expect(await runCli(["draft-conclusion"], Readable.from([JSON.stringify({ reportId, claims: [] })]), "missing-host-file")).toMatchObject({ code: 2, reply: { ok: false } });
});
