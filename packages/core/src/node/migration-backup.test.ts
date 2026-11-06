import { describe, expect, it } from "vitest";
import {
  backupFileBytes,
  copyPathOf,
  isSafeRelativePath,
  manifestSchema,
  ownerSchema,
} from "./migration-backup.js";

/** The backup's own files (format-spec §15.3): strict shapes, so anything else is unreadable. */

const owner = { pid: 4242, host: "test-host", claimedAt: "2026-11-05T10:00:00.000Z" };
const manifest = { state: "in-progress", toVersion: 2, added: ["glossary/term-2b4d6f.json"] };

describe("owner.json", () => {
  it("accepts a process id, a host name and a claim time", () => {
    expect(ownerSchema.parse(owner)).toEqual(owner);
  });

  it.each([0, -1, 2 ** 31, 1.5, Number.NaN])(
    "refuses the process id %s, which kill(pid, 0) cannot probe safely",
    (pid) => {
      expect(ownerSchema.safeParse({ ...owner, pid }).success).toBe(false);
    },
  );

  it("accepts the largest process id Node can signal", () => {
    expect(ownerSchema.safeParse({ ...owner, pid: 2 ** 31 - 1 }).success).toBe(true);
    expect(ownerSchema.safeParse({ ...owner, pid: 1 }).success).toBe(true);
  });

  it("refuses an unknown field, a missing one and a claim time that is not a real UTC time", () => {
    expect(ownerSchema.safeParse({ ...owner, extra: 1 }).success).toBe(false);
    const { host: _host, ...withoutHost } = owner;
    expect(ownerSchema.safeParse(withoutHost).success).toBe(false);
    for (const claimedAt of ["2026-02-30T10:00:00.000Z", "2026-11-05T10:00:00Z", "yesterday"]) {
      expect(ownerSchema.safeParse({ ...owner, claimedAt }).success).toBe(false);
    }
  });
});

describe("manifest.json", () => {
  it("accepts both states", () => {
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifestSchema.safeParse({ ...manifest, state: "done" }).success).toBe(true);
  });

  it("refuses an unknown state, an unknown field and a version that is not a positive integer", () => {
    expect(manifestSchema.safeParse({ ...manifest, state: "restoring" }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
    for (const toVersion of [0, 1.5, "2"]) {
      expect(manifestSchema.safeParse({ ...manifest, toVersion }).success).toBe(false);
    }
  });

  it("refuses added files that could lead outside the library, or that are not sorted", () => {
    for (const path of ["../x.json", "a//b.json", "/abs.json", "a\\b.json", "C:/x.json", "./a"]) {
      expect(manifestSchema.safeParse({ ...manifest, added: [path] }).success, path).toBe(false);
    }
    expect(manifestSchema.safeParse({ ...manifest, added: ["b.json", "a.json"] }).success).toBe(
      false,
    );
    expect(manifestSchema.safeParse({ ...manifest, added: ["a.json", "a.json"] }).success).toBe(
      false,
    );
  });
});

describe("paths", () => {
  it("keeps each copy under the backup's files folder, at its own relative path", () => {
    expect(copyPathOf("references/ref-20261101-a1b2c3.json")).toBe(
      ".tastelib/migration-backup/files/references/ref-20261101-a1b2c3.json",
    );
  });

  it("accepts the paths the format produces and nothing that leaves its place", () => {
    expect(isSafeRelativePath("projects/landing-redesign/project.json")).toBe(true);
    expect(isSafeRelativePath("library.json")).toBe(true);
    for (const path of ["", "..", "a/../b", "a/./b", "a/", "Usuário.json", "a:b"]) {
      expect(isSafeRelativePath(path), path).toBe(false);
    }
  });

  it("writes two-space JSON plus LF", () => {
    expect(new TextDecoder().decode(backupFileBytes(owner))).toBe(
      `${JSON.stringify(owner, null, 2)}\n`,
    );
  });
});
