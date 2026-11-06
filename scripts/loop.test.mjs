// Tests for the pure selection logic in loop.mjs (synthetic issues, no network).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findMilestone,
  main,
  ownPullRequest,
  parsePlanArgs,
  pickNext,
  planChanges,
  unblockChanges,
} from "./loop.mjs";

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
    const bad = [
      [],
      ["bogus"],
      ["start", "abc"],
      ["status", "x"],
      ["comment", "5"],
      ["plan", "5"],
      ["plan", "5", "M1", "bug", "extra"],
      ["plan", "5", "1"],
      ["plan", "5", "M1", "checkpoint"],
      ["plan", "5", "M1", "nonsense"],
      ["unblock", "5", "extra"],
      ["unblock", "abc"],
    ];
    for (const argv of bad) {
      assert.equal(main(argv), 2, argv.join(" "));
    }
  } finally {
    console.error = originalError;
  }
});

test("plan argument errors exit with 2 without running gh", () => {
  // With no PATH, any call to `gh` fails, and a failed call exits with 1, not 2.
  const originalError = console.error;
  const originalPath = process.env.PATH;
  console.error = () => {};
  process.env.PATH = "";
  try {
    for (const argv of [
      ["plan", "5", "1"],
      ["plan", "5", "M1", "checkpoint"],
      ["plan", "5", "M1", "nonsense"],
    ]) {
      assert.equal(main(argv), 2, argv.join(" "));
    }
  } finally {
    console.error = originalError;
    process.env.PATH = originalPath;
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

const milestones = [
  { title: "M0 Foundation", state: "open" },
  { title: "M1 Core & format", state: "open" },
  { title: "M2 Capture", state: "closed" },
  { title: "M3 Agent kit I", state: "open" },
  { title: "M3 Agent kit II", state: "open" },
];

function withState(base, state = "OPEN") {
  return { ...base, state };
}

test("plan arguments: milestone and type are checked", () => {
  assert.deepEqual(parsePlanArgs("M1"), { rank: 1, type: null });
  assert.deepEqual(parsePlanArgs("M12", "bug"), { rank: 12, type: "type: bug" });
  for (const type of ["bug", "feature", "chore", "docs", "spike"]) {
    assert.equal(parsePlanArgs("M0", type).type, `type: ${type}`);
  }
  for (const bad of [undefined, "", "1", "m1", "M", "M1 Core", "M1x"]) {
    assert.ok(parsePlanArgs(bad).error, String(bad));
  }
  assert.match(parsePlanArgs("M1", "checkpoint").error, /checkpoint/);
  assert.ok(parsePlanArgs("M1", "nonsense").error);
});

test("a milestone is found by its M<k> prefix and a space", () => {
  assert.equal(findMilestone(milestones, 1).milestone.title, "M1 Core & format");
  assert.ok(findMilestone(milestones, 9).error);
  assert.match(findMilestone(milestones, 2).error, /closed/);
  assert.match(findMilestone(milestones, 3).error, /More than one/);
  // "M1" must not match "M10 ..." or "M12 ...".
  assert.ok(findMilestone([{ title: "M10 Later", state: "open" }], 1).error);
});

test("plan moves a triaged issue into a milestone as ready", () => {
  const triaged = withState(issue(5, null, "status: triage"));
  assert.deepEqual(planChanges(triaged, milestones, "M1"), {
    milestone: "M1 Core & format",
    add: ["status: ready"],
    remove: ["status: triage"],
  });
});

test("plan with a type replaces any other type label", () => {
  const triaged = withState(issue(5, null, "status: triage", "type: chore", "type: bug"));
  const changes = planChanges(triaged, milestones, "M0", "bug");
  assert.deepEqual(changes.add, ["status: ready", "type: bug"]);
  assert.deepEqual(changes.remove, ["status: triage", "type: chore"]);
});

test("plan refuses a closed issue, one in progress, a bad milestone or a checkpoint type", () => {
  const triaged = withState(issue(5, null, "status: triage"));
  assert.match(planChanges(withState(triaged, "CLOSED"), milestones, "M1").error, /closed/);
  const running = withState(issue(5, null, "status: in progress"));
  assert.match(planChanges(running, milestones, "M1").error, /in progress/);
  assert.match(planChanges(triaged, milestones, "M2").error, /closed/);
  assert.match(planChanges(triaged, milestones, "M3").error, /More than one/);
  assert.ok(planChanges(triaged, milestones, "M9").error);
  assert.ok(planChanges(triaged, milestones, "M1", "checkpoint").error);
  const checkpoint = withState(issue(6, "M1 Core & format", "type: checkpoint", "status: blocked"));
  assert.match(planChanges(checkpoint, milestones, "M1", "bug").error, /checkpoint/);
});

test("unblock lifts the block and marks the issue ready", () => {
  const blocked = issue(4, "M0 Foundation", "status: blocked");
  assert.deepEqual(unblockChanges(blocked), {
    add: ["status: ready"],
    remove: ["status: blocked"],
  });
});

test("unblock refuses a checkpoint and an issue that is not blocked", () => {
  const checkpoint = issue(3, "M0 Foundation", "type: checkpoint", "status: blocked");
  assert.match(unblockChanges(checkpoint).error, /checkpoint/);
  assert.match(unblockChanges(issue(4, "M0 Foundation", "status: ready")).error, /not blocked/);
});

test("plan without a type leaves the type labels alone", () => {
  const triaged = withState(issue(5, null, "status: triage", "type: bug"));
  const changes = planChanges(triaged, milestones, "M1");
  assert.deepEqual(changes.add, ["status: ready"]);
  assert.deepEqual(changes.remove, ["status: triage"]);
});

test("plan keeps a blocked issue blocked: it does not add ready", () => {
  const blocked = withState(
    issue(6, null, "status: triage", "status: blocked", "type: checkpoint"),
  );
  const changes = planChanges(blocked, milestones, "M1");
  assert.deepEqual(changes.add, []);
  assert.deepEqual(changes.remove, ["status: triage"]);
});

test("unblock refuses a closed issue", () => {
  const closed = withState(issue(4, "M0 Foundation", "status: blocked"), "CLOSED");
  assert.match(unblockChanges(closed).error, /closed/);
});
