import { describe, expect, it } from "vitest";
import { effectiveOf, linkWeight } from "./effective.js";

const T = "2026-11-02T09:00:00.000Z";

const agent = (status: "to-review" | "accepted" | "corrected" | "rejected") => ({
  origin: "agent" as const,
  proposedBy: "claude-code",
  proposedAt: T,
  inputSha256: null,
  proposal: "the agent's words",
  status,
  correction: status === "corrected" ? "the user's version" : null,
  reviewedAt: status === "to-review" ? null : T,
});

describe("effectiveOf (format-spec §13.3)", () => {
  it("a user value is its content, not tentative", () => {
    const user = { origin: "user" as const, content: "mine", writtenAt: T };
    expect(effectiveOf(user)).toEqual({
      value: "mine",
      tentative: false,
    });
  });

  it("an accepted proposal is the proposal, not tentative", () => {
    expect(effectiveOf(agent("accepted"))).toEqual({
      value: "the agent's words",
      tentative: false,
    });
  });

  it("a corrected proposal is the correction, not tentative", () => {
    expect(effectiveOf(agent("corrected"))).toEqual({
      value: "the user's version",
      tentative: false,
    });
  });

  it("a proposal to review is the proposal, marked tentative", () => {
    expect(effectiveOf(agent("to-review"))).toEqual({
      value: "the agent's words",
      tentative: true,
    });
  });

  it("a rejected proposal has no effective value", () => {
    expect(effectiveOf(agent("rejected"))).toBeNull();
  });
});

describe("linkWeight (format-spec §13.3, links)", () => {
  const link = (status: "to-review" | "accepted" | "rejected") => ({
    target: "ref-20261101-a1b2c3#p0",
    origin: "agent" as const,
    proposedBy: "claude-code",
    proposedAt: T,
    status,
    reviewedAt: status === "to-review" ? null : T,
  });

  it("a user link counts", () => {
    const user = { target: "ref-20261101-a1b2c3#p0", origin: "user" as const, addedAt: T };
    expect(linkWeight(user)).toBe("counts");
  });

  it("an accepted agent link counts", () => {
    expect(linkWeight(link("accepted"))).toBe("counts");
  });

  it("a link to review is tentative", () => {
    expect(linkWeight(link("to-review"))).toBe("tentative");
  });

  it("a rejected link does not count", () => {
    expect(linkWeight(link("rejected"))).toBe("none");
  });
});
