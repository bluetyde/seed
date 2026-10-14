import { describe, expect, it } from "vitest";
import { FIXTURE_HUMAN, makeHeader } from "./helpers/studyFixtures";

// The default human of the study fixtures must not be mistakable for a real person: a header is read as data and SEED cannot tell who wrote it.
describe("the study fixtures", () => {
  it("name their human so that it is plainly not a person", () => {
    expect(FIXTURE_HUMAN).toEqual({ kind: "human", name: "FIXTURE, not a person" });
    expect(makeHeader().setBy).toEqual(FIXTURE_HUMAN);
    expect(JSON.stringify(makeHeader())).not.toMatch(/Alice/);
  });
});
