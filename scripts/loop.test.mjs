// Tests for the pure selection logic in loop.mjs (synthetic issues, no network).

import assert from "node:assert/strict";
import { test } from "node:test";
import { main, ownPullRequest, pickNext } from "./loop.mjs";

function issue(number, milestone = null, ...labels) {
  return {
    number,
    title: `Issue ${number}`,
    labels: labels.map((name) => ({ name })),
    milestone: milestone ? { title: milestone, number: 1 } : null,
  };
}

test("resumes the issue in progress", () => {
  const issues = [
    issue(3, "M0 Foundation", "status: ready"),
    issue(7, "M1 Core", "status: in progress"),
  ];
  assert.deepEqual(pickNext(issues), ["resume", [issues[1]]]);
});

test("takes the lowest number in the earliest milestone", () => {
  const issues = [issue(2, "M1 Core"), issue(9, "M0 Foundation"), issue(5, "M0 Foundation")];
  const [action, picked] = pickNext(issues);
  assert.deepEqual([action, picked[0].number], ["start", 5]);
});

test("milestones sort by number, not text", () => {
  const issues = [issue(1, "M10 Later"), issue(2, "M2 Capture")];
  assert.equal(pickNext(issues)[1][0].number, 2);
});

test("skips blocked issues", () => {
  const issues = [issue(4, "M0 Foundation", "status: blocked"), issue(6, "M0 Foundation")];
  assert.equal(pickNext(issues)[1][0].number, 6);
});

test("stops at a checkpoint", () => {
  const issues = [
    issue(8, "M2 Capture", "type: checkpoint", "status: blocked"),
    issue(9, "M3 Agent kit"),
  ];
  assert.deepEqual(pickNext(issues), ["checkpoint", [issues[0]]]);
});

test("open work comes before a later checkpoint", () => {
  const issues = [
    issue(5, "M2 Capture"),
    issue(8, "M2 Capture", "type: checkpoint", "status: blocked"),
  ];
  assert.equal(pickNext(issues)[1][0].number, 5);
});

test("a checkpoint with a lower number comes after open work", () => {
  const issues = [
    issue(2, "M0 Foundation", "type: checkpoint", "status: blocked"),
    issue(7, "M0 Foundation"),
  ];
  assert.deepEqual(pickNext(issues), ["start", [issues[1]]]);
});

test("a checkpoint plus blocked issues stops at the checkpoint", () => {
  const issues = [
    issue(2, "M0 Foundation", "status: blocked"),
    issue(3, "M0 Foundation", "type: checkpoint", "status: blocked"),
  ];
  assert.deepEqual(pickNext(issues), ["checkpoint", [issues[1]]]);
});

test("a checkpoint alone stops", () => {
  const issues = [issue(3, "M0 Foundation", "type: checkpoint", "status: blocked")];
  assert.deepEqual(pickNext(issues), ["checkpoint", [issues[0]]]);
});

test("all blocked stops", () => {
  const issues = [issue(4, "M0 Foundation", "status: blocked"), issue(5, "M1 Core")];
  assert.deepEqual(pickNext(issues), ["blocked", [issues[0]]]);
});

test("ignores issues without a milestone", () => {
  assert.deepEqual(pickNext([issue(1)]), ["empty", []]);
});

test("argument errors exit with 2 before any network call", () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const argv of [[], ["bogus"], ["start", "abc"], ["status", "x"], ["comment", "5"]]) {
      assert.equal(main(argv), 2, argv.join(" "));
    }
  } finally {
    console.error = originalError;
  }
});

test("--help exits with 0", () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(main(["--help"]), 0);
  } finally {
    console.log = originalLog;
  }
});

test("a pull request from a fork or by someone else is never taken for the maintainer's own", () => {
  const own = { number: 5, isCrossRepository: false, author: { login: "dk-1ng" } };
  const fork = { number: 6, isCrossRepository: true, author: { login: "dk-1ng" } };
  const stranger = { number: 7, isCrossRepository: false, author: { login: "someone" } };
  assert.equal(ownPullRequest([fork, stranger]), null);
  assert.equal(ownPullRequest([fork, stranger, own]), own);
  assert.equal(ownPullRequest([]), null);
});
