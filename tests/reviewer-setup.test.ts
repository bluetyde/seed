import { describe, expect, it } from "vitest";
import { reviewerSetupProblem } from "../src/core/conclusionReview";

const file = { uid: 1000, mode: 0o100644 };
const posix = { username: "alice", uid: 1000, platform: "linux" };

describe("reviewer setup binding (review hardening 2026-10-05)", () => {
  it("accepts the named account's own, not group- or world-writable file", () => {
    expect(reviewerSetupProblem({ osUser: "alice" }, file, posix)).toBeNull();
    expect(reviewerSetupProblem({ osUser: "alice" }, { uid: 1000, mode: 0o100600 }, posix)).toBeNull();
  });
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 7],
    ["too long", "x".repeat(257)],
  ])("refuses an osUser that is %s", (_n, osUser) => {
    expect(reviewerSetupProblem({ osUser }, file, posix)).toMatch(/must name the operating-system account/);
  });
  it("refuses a file made for another account, case-sensitively on POSIX", () => {
    expect(reviewerSetupProblem({ osUser: "bob" }, file, posix)).toMatch(/another operating-system account/);
    expect(reviewerSetupProblem({ osUser: "Alice" }, file, posix)).toMatch(/another operating-system account/);
  });
  it("refuses a file owned by someone else and one writable by group or others", () => {
    expect(reviewerSetupProblem({ osUser: "alice" }, { uid: 0, mode: 0o100644 }, posix)).toMatch(/not owned/);
    expect(reviewerSetupProblem({ osUser: "alice" }, { uid: 1000, mode: 0o100664 }, posix)).toMatch(/writable by group or others/);
    expect(reviewerSetupProblem({ osUser: "alice" }, { uid: 1000, mode: 0o100646 }, posix)).toMatch(/writable by group or others/);
    expect(reviewerSetupProblem({ osUser: "alice" }, file, { username: "alice", platform: "linux" })).toMatch(/not owned/);
  });
  it("on Windows the account name is compared without case and file modes are not judged", () => {
    const win = { username: "JWNCR", platform: "win32" };
    expect(reviewerSetupProblem({ osUser: "jwncr" }, { uid: 0, mode: 0o100666 }, win)).toBeNull();
    expect(reviewerSetupProblem({ osUser: "other" }, { uid: 0, mode: 0o100666 }, win)).toMatch(/another operating-system account/);
  });
});
