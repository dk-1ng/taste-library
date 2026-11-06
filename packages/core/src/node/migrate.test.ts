import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { recordPoints } from "../../test/support/crash.js";
import { editJson, readTree, withGoldenCopy } from "../../test/support/golden.js";
import { type Json, open, readJson, tree } from "../../test/support/library.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { FORMAT_REGISTRY } from "../format.js";
import { type MigrationPlan, planMigration } from "../migrations/plan.js";
import { dryRunMigration } from "./migrate.js";
import type { OpenOptions } from "./open.js";
import { type FileSystem, realFileSystem } from "./replace-file.js";

/**
 * Migrating a library on disk (format-spec §15.3; docs/design.md section 4, "Write gate" and
 * "`tastelib migrate`"), and the dry run, which plans in memory and writes nothing, not even
 * `.tastelib/`. The runner is tested with the test-only version 2 (docs/design.md section 15,
 * "Core test approach").
 */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;
const HOST = "test-host";
const PID = 4242;
const BACKUP = ".tastelib/migration-backup";
const decoder = new TextDecoder();

/** The points of the replace primitive, which the runner's own points are read without. */
const PRIMITIVE_POINTS = new Set(["temp-written", "before-rename", "before-unlink"]);

/** Opens `library` with the test registry and an injected owner (host name and process id). */
async function openOlder(library: string, options: OpenOptions = {}) {
  return open(library, TEST_REGISTRY, { hostName: HOST, pid: PID, ...options });
}

type Ready = Extract<MigrationPlan, { status: "ready" }>;

/** The plan of the library as it is on disk now. */
async function planOf(library: string): Promise<Ready> {
  const handle = await open(library, TEST_REGISTRY);
  const snapshot = await handle.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  const plan = planMigration(TEST_REGISTRY, snapshot.snapshot, sha256);
  if (plan.status !== "ready") throw new Error(`the plan is ${plan.status}`);
  return plan;
}

/** The issues of the library on disk, read with the test registry, without the `info` ones. */
async function issuesAtV2(library: string) {
  const handle = await open(library, TEST_REGISTRY);
  const snapshot = await handle.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  return snapshot.snapshot.issues.filter((issue) => issue.severity !== "info");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const at = (library: string, path: string) => join(library, ...path.split("/"));

/** A library path of the event log: relative to the library with `/`, the library itself `.`. */
function relativeTo(library: string, path: string): string {
  const inside = relative(library, path).split(sep).join("/");
  return inside === "" ? "." : inside;
}

/**
 * The real file system, recording each flush (`sync <path>`, a temporary file or a folder),
 * rename, removal and folder creation, in order, with paths relative to the library. A folder is
 * not really opened, since Windows cannot open one for reading: its flush is only recorded, so the
 * test runs alike on every system with the platform injected.
 */
function recordingFs(library: string): { fs: FileSystem; events: string[] } {
  const events: string[] = [];
  const rel = (path: unknown) => relativeTo(library, String(path));
  const fs: FileSystem = {
    ...realFileSystem,
    open: (async (...args: Parameters<FileSystem["open"]>) => {
      const folder = await stat(args[0]).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (folder) {
        return {
          sync: async () => void events.push(`sync ${rel(args[0])}`),
          close: async () => undefined,
        };
      }
      const handle = await realFileSystem.open(...args);
      const sync = handle.sync.bind(handle);
      Object.assign(handle, {
        sync: async () => {
          events.push(`sync ${rel(args[0])}`);
          return sync();
        },
      });
      return handle;
    }) as FileSystem["open"],
    rename: async (from, to) => {
      events.push(`rename ${rel(from)} ${rel(to)}`);
      return realFileSystem.rename(from, to);
    },
    unlink: async (path) => {
      events.push(`unlink ${rel(path)}`);
      return realFileSystem.unlink(path);
    },
    mkdir: (async (...args: Parameters<FileSystem["mkdir"]>) => {
      events.push(`mkdir ${rel(args[0])}`);
      return realFileSystem.mkdir(...args);
    }) as FileSystem["mkdir"],
  };
  return { fs, events };
}

describe("library.migrate", () => {
  it("migrates the golden v1 library on disk and returns migrated with its lists; the result validates", async () => {
    await withGoldenCopy(async (library) => {
      const plan = await planOf(library);
      const handle = await openOlder(library);
      const result = await handle.migrate({ clock });
      expect(result).toEqual({
        status: "migrated",
        from: 1,
        to: 2,
        changed: plan.changed,
        added: plan.added,
        removed: ["glossary.json"],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(plan.added).toContain("glossary/term-2b4d6f.json");
      expect(plan.changed).toContain("library.json");
      const files = await readTree(library);
      for (const [path, bytes] of plan.bytes) expect(files.get(path), path).toEqual(bytes);
      expect(files.has("glossary.json")).toBe(false);
      expect(await issuesAtV2(library)).toEqual([]);
      expect(await exists(at(library, BACKUP))).toBe(false);
      // The handle sees the migrated library.
      const snapshot = await handle.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.message);
      expect(snapshot.snapshot.formatVersion).toBe(2);
      expect(snapshot.snapshot.index.versions.present).toEqual([2]);
    });
  });

  it("calls the runner's points in order: claim, owner, copies, manifest, writes, deletions, library.json, done, backup deleted with owner.json last", async () => {
    await withGoldenCopy(async (library) => {
      const plan = await planOf(library);
      const { points, at: record } = recordPoints();
      const handle = await openOlder(library);
      await handle.migrate({ clock, at: record });
      const copied = [...plan.changed, ...plan.removed].sort();
      const written = [...plan.changed, ...plan.added].filter((p) => p !== "library.json").sort();
      expect(points.filter((point) => !PRIMITIVE_POINTS.has(point))).toEqual([
        "claimed",
        "owner-written",
        ...copied.map((path) => `copied:${path}`),
        "manifest-written",
        ...written.map((path) => `wrote:${path}`),
        ...plan.removed.map((path) => `deleted:${path}`),
        "library-json-written",
        "done-written",
        ...copied.map((path) => `backup-deleted:files/${path}`),
        "backup-deleted:manifest.json",
        "owner-deleted",
      ]);
    });
  });

  it("writes owner.json before any copy, every copy as read from disk, the manifest after the last copy, library.json last, then done", async () => {
    await withGoldenCopy(async (library) => {
      const before = await readTree(library);
      const plan = await planOf(library);
      const copied = [...plan.changed, ...plan.removed].sort();
      const read = async (path: string) => new Uint8Array(await readFile(at(library, path)));
      const seen: string[] = [];
      const check = async (point: string): Promise<void> => {
        const owner = at(library, `${BACKUP}/owner.json`);
        const manifest = at(library, `${BACKUP}/manifest.json`);
        if (point === "claimed") {
          expect(await exists(owner)).toBe(false);
          seen.push(point);
        } else if (point === "owner-written") {
          expect(await readJson(library, `${BACKUP}/owner.json`)).toEqual({
            pid: PID,
            host: HOST,
            claimedAt: NOW.toISOString(),
          });
          expect(await exists(at(library, `${BACKUP}/files`))).toBe(false);
          seen.push(point);
        } else if (point.startsWith("copied:")) {
          const path = point.slice("copied:".length);
          expect(await exists(owner)).toBe(true);
          expect(await exists(manifest)).toBe(false);
          expect(await read(`${BACKUP}/files/${path}`)).toEqual(before.get(path));
          seen.push("copied");
        } else if (point === "manifest-written") {
          expect(await readJson(library, `${BACKUP}/manifest.json`)).toEqual({
            state: "in-progress",
            toVersion: 2,
            added: plan.added,
          });
          for (const path of copied) {
            expect(await read(`${BACKUP}/files/${path}`)).toEqual(before.get(path));
          }
          expect(await read("library.json")).toEqual(before.get("library.json"));
          seen.push(point);
        } else if (point.startsWith("wrote:") || point.startsWith("deleted:")) {
          expect(await read("library.json"), point).toEqual(before.get("library.json"));
          expect((await readJson(library, `${BACKUP}/manifest.json`)).state).toBe("in-progress");
          seen.push("step-5");
        } else if (point === "library-json-written") {
          expect(await read("library.json")).toEqual(plan.bytes.get("library.json"));
          expect((await readJson(library, `${BACKUP}/manifest.json`)).state).toBe("in-progress");
          for (const path of plan.changed) {
            expect(await read(path), path).toEqual(plan.bytes.get(path));
          }
          seen.push(point);
        } else if (point === "done-written") {
          expect(await readJson(library, `${BACKUP}/manifest.json`)).toEqual({
            state: "done",
            toVersion: 2,
            added: plan.added,
          });
          seen.push(point);
        }
      };
      const handle = await openOlder(library);
      const result = await handle.migrate({ clock, at: check });
      expect(result.status).toBe("migrated");
      expect([...new Set(seen)]).toEqual([
        "claimed",
        "owner-written",
        "copied",
        "manifest-written",
        "step-5",
        "library-json-written",
        "done-written",
      ]);
      expect(await exists(at(library, BACKUP))).toBe(false);
    });
  });

  it("copies each backup from disk after the claim: a file changed since step 1 refuses with write-conflict before the manifest, and no copy holds the old bytes", async () => {
    await withGoldenCopy(async (library) => {
      const changed = "references/ref-20261103-g7h8j9.json";
      const before = await readTree(library);
      const handle = await openOlder(library);
      await handle.snapshot();
      const edited = `${decoder.decode(before.get(changed))} `;
      const result = await handle.migrate({
        clock,
        at: async (point) => {
          if (point === "claimed") await writeFile(at(library, changed), edited);
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: changed }],
        notices: [],
      });
      expect(await exists(at(library, `${BACKUP}/manifest.json`))).toBe(false);
      expect(await exists(at(library, `${BACKUP}/files/${changed}`))).toBe(false);
      const after = await readTree(library);
      for (const [path, bytes] of before) {
        if (path !== changed) expect(after.get(path), path).toEqual(bytes);
      }
      expect(decoder.decode(after.get(changed))).toBe(edited);
      expect(JSON.stringify(result)).not.toContain(library);
    });
  });

  it("makes every step durable: each file flushed before its rename, each folder it touched flushed after", async () => {
    await withGoldenCopy(async (library) => {
      const plan = await planOf(library);
      const { fs, events } = recordingFs(library);
      const handle = await openOlder(library);
      expect((await handle.migrate({ clock, fs, platform: "linux" })).status).toBe("migrated");

      const isFolderSync = (event: string) => event.startsWith("sync ") && !event.includes(".tmp-");
      const claim = events.indexOf(`mkdir ${BACKUP}`);
      expect(events.indexOf("mkdir .tastelib")).toBeLessThan(claim);
      const firstRename = events.findIndex((event) => event.startsWith("rename "));
      // The claim's folder entries: `.tastelib/` in the library folder, the backup in `.tastelib/`.
      for (const folder of [".tastelib", "."]) {
        const flush = events.indexOf(`sync ${folder}`, claim);
        expect(flush, folder).toBeGreaterThan(claim);
        expect(flush, folder).toBeLessThan(firstRename);
      }
      // Steps 4 to 6: every rename (owner.json, copies, manifest, library files) and every
      // deletion of a library file. Step 7 needs no flush.
      const done = events.findIndex((e) => e.startsWith("rename ") && e.endsWith("manifest.json"));
      const lastDone = events.findLastIndex(
        (e) => e.startsWith("rename ") && e.endsWith("manifest.json"),
      );
      expect(lastDone).toBeGreaterThan(done);
      const changes = events
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => index <= lastDone && /^(rename|unlink) /.test(event));
      expect(changes.length).toBe(
        2 +
          1 +
          (plan.changed.length + plan.removed.length) +
          plan.changed.length +
          plan.added.length +
          plan.removed.length,
      );
      for (const [n, { event, index }] of changes.entries()) {
        const next = changes[n + 1]?.index ?? events.length;
        const [operation, from, to] = event.split(" ") as [string, string, string?];
        if (operation === "rename") {
          expect(events.lastIndexOf(`sync ${from}`, index), event).toBeGreaterThanOrEqual(0);
        }
        const folder = dirname(to ?? from);
        const flush = events.findIndex((e, i) => i > index && i < next && e === `sync ${folder}`);
        expect(flush, `${event} then sync ${folder}`).toBeGreaterThan(index);
      }
      // Folders the runner created are flushed in their parent: the copies' folders, and
      // `glossary/`, which the step adds.
      for (const [created, parent] of [
        [`${BACKUP}/files`, BACKUP],
        [`${BACKUP}/files/references`, `${BACKUP}/files`],
        ["glossary", "."],
      ] as const) {
        const made = events.indexOf(`mkdir ${created}`);
        expect(made, created).toBeGreaterThanOrEqual(0);
        expect(events.indexOf(`sync ${parent}`, made), created).toBeGreaterThan(made);
      }
      expect(events.filter(isFolderSync).length).toBeGreaterThan(0);
    });
  });

  it("flushes no folder on Windows, and still flushes every file before its rename", async () => {
    await withGoldenCopy(async (library) => {
      const { fs, events } = recordingFs(library);
      const handle = await openOlder(library);
      expect((await handle.migrate({ clock, fs, platform: "win32" })).status).toBe("migrated");
      const syncs = events.filter((event) => event.startsWith("sync "));
      expect(syncs.filter((event) => !event.includes(".tmp-"))).toEqual([]);
      const renames = events.filter((event) => event.startsWith("rename "));
      expect(renames.length).toBeGreaterThan(0);
      for (const rename of renames) {
        const from = rename.split(" ")[1];
        expect(syncs, rename).toContain(`sync ${from}`);
      }
    });
  });

  it("gives identical bytes from two runs on two copies", async () => {
    await withGoldenCopy(async (first) => {
      await withGoldenCopy(async (second) => {
        await (await openOlder(first)).migrate({ clock });
        await (await openOlder(second, { hostName: "another-host", pid: 7 })).migrate({
          clock: () => new Date("2026-12-01T00:00:00.000Z"),
        });
        const a = await readTree(first);
        expect(a.size).toBeGreaterThan(0);
        expect(await readTree(second)).toEqual(a);
        expect(await tree(second)).toEqual(await tree(first));
      });
    });
  });

  it("migrates a mixed library whose library.json is current without rewriting library.json; the notice is from the lowest version", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "library.json", (value) => {
        value.formatVersion = 2;
      });
      const before = await readTree(library);
      const { points, at: record } = recordPoints();
      const handle = await openOlder(library);
      const result = await handle.migrate({ clock, at: record });
      expect(result).toMatchObject({
        status: "migrated",
        from: 1,
        to: 2,
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      if (result.status !== "migrated") return;
      expect(result.changed).not.toContain("library.json");
      expect(points).not.toContain("library-json-written");
      expect(points).not.toContain("copied:library.json");
      expect((await readTree(library)).get("library.json")).toEqual(before.get("library.json"));
      expect(await issuesAtV2(library)).toEqual([]);
    });
  });

  it("refuses a migration that cannot run and leaves every file byte for byte, with no .tastelib", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "guardrails.json"), "{ not json");
      const before = await tree(library);
      const handle = await openOlder(library);
      const result = await handle.migrate({ clock });
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "invalid-json", file: "guardrails.json" }],
        notices: [],
      });
      expect(await tree(library)).toEqual(before);
      expect(await exists(join(library, ".tastelib"))).toBe(false);
    });
  });

  it("writes nothing for a current library, not even .tastelib", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const handle = await open(library);
      expect(await handle.migrate({ clock })).toEqual({ status: "current", notices: [] });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("reports nothing to migrate once it has migrated", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await openOlder(library);
      await handle.migrate({ clock });
      const after = await tree(library);
      expect(await handle.migrate({ clock })).toEqual({ status: "current", notices: [] });
      expect(await (await openOlder(library)).migrate({ clock })).toEqual({
        status: "current",
        notices: [],
      });
      expect(await tree(library)).toEqual(after);
    });
  });

  it("tells the handle what it wrote, so the next snapshot reads it back even when stat shows nothing changed", async () => {
    await withGoldenCopy(async (library) => {
      // Stats frozen at their first answer, and a clock far ahead, so every file looks settled
      // and unchanged to a refresh: only what the runner reports makes it read a file again.
      const frozen = new Map<string, BigIntStats>();
      const frozenStat = async (path: string, options: { bigint: true }) => {
        const known = frozen.get(path);
        if (known !== undefined) return known;
        const stats = await stat(path, options);
        frozen.set(path, stats);
        return stats;
      };
      const handle = await openOlder(library, {
        stat: frozenStat,
        statClock: () => Date.now() + 3_600_000,
      });
      await handle.snapshot();
      expect((await handle.migrate({ clock })).status).toBe("migrated");
      const snapshot = await handle.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.message);
      expect(snapshot.snapshot.index.versions.present).toEqual([2]);
      expect(snapshot.snapshot.files.get("library.json")?.formatVersion).toBe(2);
    });
  });

  it("turns an error looking for the backup through the injected file system into an io-error result", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const fs: FileSystem = {
        ...realFileSystem,
        lstat: (async (path: Parameters<FileSystem["lstat"]>[0]) => {
          if (String(path).endsWith("migration-backup")) throw injected("EACCES", "lstat", path);
          return realFileSystem.lstat(path);
        }) as FileSystem["lstat"],
      };
      const handle = await openOlder(library);
      const result = await handle.migrate({ clock, fs });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "lstat", file: BACKUP, errno: "EACCES" },
        notices: [],
      });
      expect(JSON.stringify(result)).not.toContain(library);
      expect(await tree(library)).toEqual(before);
      // A write takes the same look.
      expect(await handle.write(() => ({ changes: [], skipped: [] }), { clock, fs })).toMatchObject(
        { status: "failed", failure: { operation: "lstat", errno: "EACCES" } },
      );
    });
  });
});

/** An error as Node gives it: an errno code, and a message that names the absolute path. */
function injected(code: string, operation: string, path: unknown): Error {
  return Object.assign(new Error(`${code}: injected, ${operation} '${String(path)}'`), { code });
}

describe("a claim that fails leaves nothing behind", () => {
  it("fails with io-error when .tastelib cannot be created, and writes nothing", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const fs: FileSystem = {
        ...realFileSystem,
        mkdir: (async (...args: Parameters<FileSystem["mkdir"]>) => {
          if (String(args[0]).endsWith(".tastelib")) throw injected("EACCES", "mkdir", args[0]);
          return realFileSystem.mkdir(...args);
        }) as FileSystem["mkdir"],
      };
      const result = await (await openOlder(library)).migrate({ clock, fs });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "mkdir", file: ".tastelib", errno: "EACCES" },
        notices: [],
      });
      expect(JSON.stringify(result)).not.toContain(library);
      expect(await tree(library)).toEqual(before);
    });
  });

  it("refuses with write-conflict when another process claims the backup folder first, and leaves its claim", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const backup = at(library, BACKUP);
      const fs: FileSystem = {
        ...realFileSystem,
        mkdir: (async (...args: Parameters<FileSystem["mkdir"]>) => {
          // The other process wins the race between the gate's look and this claim.
          if (args[0] === backup) await realFileSystem.mkdir(backup);
          return realFileSystem.mkdir(...args);
        }) as FileSystem["mkdir"],
      };
      const result = await (await openOlder(library)).migrate({ clock, fs });
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: BACKUP }],
        notices: [],
      });
      expect(await tree(library)).toEqual({
        ...before,
        ".tastelib/": "",
        ".tastelib/migration-backup/": "",
      });
    });
  });

  it("removes the empty claim and the .tastelib it created when owner.json cannot be written", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const fs: FileSystem = {
        ...realFileSystem,
        open: (async (...args: Parameters<FileSystem["open"]>) => {
          if (String(args[0]).includes(".owner.json.tmp-"))
            throw injected("ENOSPC", "open", args[0]);
          return realFileSystem.open(...args);
        }) as FileSystem["open"],
      };
      const { points, at: record } = recordPoints();
      const result = await (await openOlder(library)).migrate({ clock, fs, at: record });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "write", file: `${BACKUP}/owner.json` },
        notices: [],
      });
      expect(JSON.stringify(result)).not.toContain(library);
      expect(points).toEqual(["claimed"]);
      expect(await tree(library)).toEqual(before);
    });
  });

  it("removes only the empty claim when .tastelib was already there", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib"));
      await writeFile(join(library, ".tastelib", "cache"), "the tool's own");
      const before = await tree(library);
      const fs: FileSystem = {
        ...realFileSystem,
        open: (async (...args: Parameters<FileSystem["open"]>) => {
          if (String(args[0]).includes(".owner.json.tmp-")) throw injected("EIO", "open", args[0]);
          return realFileSystem.open(...args);
        }) as FileSystem["open"],
      };
      const result = await (await openOlder(library)).migrate({ clock, fs });
      expect(result).toMatchObject({ status: "failed", failure: { errno: "EIO" } });
      expect(await tree(library)).toEqual(before);
    });
  });
});

describe("the write gate migrates an older library first", () => {
  it("migrates before the plan is built, so build sees version 2, and says so in the result", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await openOlder(library);
      let seen: number | null = null;
      const result = await handle.write(
        (snapshot) => {
          seen = snapshot.formatVersion;
          expect(snapshot.files.has("glossary.json")).toBe(false);
          expect(snapshot.files.get("glossary/term-2b4d6f.json")?.status).toBe("valid");
          const guardrails = structuredClone(snapshot.files.get("guardrails.json")?.value) as Json;
          guardrails.guardrails[0].rule.content.text = "No banners that compete with the content.";
          return { changes: [{ path: "guardrails.json", next: guardrails }], skipped: [] };
        },
        { clock },
      );
      expect(seen).toBe(2);
      expect(result).toEqual({
        status: "written",
        written: ["guardrails.json"],
        skipped: [],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect((await readJson(library, "guardrails.json")).formatVersion).toBe(2);
      expect(await issuesAtV2(library)).toEqual([]);
    });
  });

  it("keeps the migrated notice when the plan is then refused", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await openOlder(library);
      const result = await handle.write(
        (snapshot) => {
          const guardrails = structuredClone(snapshot.files.get("guardrails.json")?.value) as Json;
          guardrails.unknownField = true;
          return { changes: [{ path: "guardrails.json", next: guardrails }], skipped: [] };
        },
        { clock },
      );
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "schema-violation", file: "guardrails.json" }],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      // The library was migrated all the same.
      expect((await readJson(library, "library.json")).formatVersion).toBe(2);
    });
  });

  it("keeps the migrated notice when the plan changes nothing", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await openOlder(library);
      const result = await handle.write(() => ({ changes: [], skipped: [] }), { clock });
      expect(result).toEqual({
        status: "unchanged",
        skipped: [],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      // The next write finds a current library: no notice.
      expect(await handle.write(() => ({ changes: [], skipped: [] }), { clock })).toEqual({
        status: "unchanged",
        skipped: [],
        notices: [],
      });
    });
  });

  it("refuses a library with a newer file before any migration", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "references/ref-20261103-g7h8j9.json", (value) => {
        value.formatVersion = 3;
      });
      const before = await tree(library);
      const handle = await openOlder(library);
      const result = await handle.write(() => ({ changes: [], skipped: [] }), { clock });
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "newer-format", file: "references/ref-20261103-g7h8j9.json" }],
        notices: [],
      });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("still refuses with write-conflict while a migration backup exists, and migrates nothing", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib", "migration-backup"), { recursive: true });
      const before = await tree(library);
      const handle = await openOlder(library);
      const result = await handle.write(() => ({ changes: [], skipped: [] }), { clock });
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: BACKUP }],
        notices: [],
      });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("refuses with the issues of the files that block the migration, and writes nothing", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "guardrails.json"), "{ not json");
      const before = await tree(library);
      const handle = await openOlder(library);
      let built = false;
      const result = await handle.write(
        () => {
          built = true;
          return { changes: [], skipped: [] };
        },
        { clock },
      );
      expect(built).toBe(false);
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "invalid-json", file: "guardrails.json" }],
        written: [],
        notWritten: [],
        notices: [],
      });
      expect(await tree(library)).toEqual(before);
    });
  });
});

describe("dryRunMigration", () => {
  it("returns the plan of an older library and leaves the folder byte for byte as it was", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const handle = await open(library, TEST_REGISTRY);
      const result = await dryRunMigration(library, handle, { registry: TEST_REGISTRY });
      const snapshot = await handle.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const plan = planMigration(TEST_REGISTRY, snapshot.snapshot, sha256);
      if (plan.status !== "ready" || result.status !== "ready") throw new Error("not ready");
      // The same plan; the migrated snapshots hold functions, so they are compared by their files.
      const { migrated, ...lists } = result;
      const { migrated: expected, ...expectedLists } = plan;
      expect(lists).toEqual(expectedLists);
      expect([...migrated.files.keys()]).toEqual([...expected.files.keys()]);
      expect(result).toMatchObject({ status: "ready", from: 1, to: 2, removed: ["glossary.json"] });
      expect(await tree(library)).toEqual(before);
      expect(Object.keys(before).some((path) => path.startsWith(".tastelib"))).toBe(false);
    });
  });

  it("says a current library is current, and writes nothing", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library));
      expect(result).toEqual({ status: "current" });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("returns the issues that block the migration", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "guardrails.json"), "{ not json");
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toMatchObject({
        status: "blocked",
        step: 1,
        issues: [{ code: "invalid-json", file: "guardrails.json" }],
      });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("gives no plan when a migration backup exists, and leaves it as it is", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib", "migration-backup"), { recursive: true });
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toEqual({ status: "backup" });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("finds the backup with lstat, so a link there that leads nowhere counts", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib"));
      try {
        await symlink(join(library, "nowhere"), join(library, ".tastelib", "migration-backup"));
      } catch {
        return; // creating links needs extra rights on some Windows setups
      }
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toEqual({ status: "backup" });
    });
  });

  it("plans when .tastelib is a file, which holds no backup", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, ".tastelib"), "");
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toMatchObject({ status: "ready" });
    });
  });

  it("turns an error looking for the backup into an io-error result, never a throw", async () => {
    await withGoldenCopy(async (library) => {
      const lstat = async (): Promise<never> => {
        throw Object.assign(new Error("injected"), { code: "EACCES" });
      };
      const result = await dryRunMigration(library, await open(library), {
        registry: FORMAT_REGISTRY,
        lstat,
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "io-error",
          operation: "lstat",
          file: ".tastelib/migration-backup",
          errno: "EACCES",
        },
      });
      expect(JSON.stringify(result)).not.toContain(library);
    });
  });

  it("returns the open failure when the folder is no longer a library", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await open(library);
      await rm(join(library, "library.json"));
      expect(await dryRunMigration(library, handle)).toEqual({
        status: "failed",
        failure: { code: "not-a-library", message: expect.any(String) },
      });
    });
  });
});
