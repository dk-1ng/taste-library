import { describe, expect, it } from "vitest";
import { skipReasonOf } from "./plan.js";

describe("skipReasonOf", () => {
  it("gives no reason for a valid file and the status for any other", () => {
    expect(skipReasonOf("valid")).toBeNull();
    expect(skipReasonOf("invalid")).toBe("invalid");
    expect(skipReasonOf("unreadable")).toBe("unreadable");
    expect(skipReasonOf("newer")).toBe("newer");
  });
});
