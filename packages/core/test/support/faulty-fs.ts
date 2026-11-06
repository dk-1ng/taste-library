import { relative, sep } from "node:path";
import { type FileSystem, realFileSystem } from "../../src/node/replace-file.js";

/**
 * A file system that injects I/O errors (docs/design.md section 15, "Core test approach", "Crash
 * points"): it wraps the real one (or another adapter) and fails chosen calls with an `errno` code,
 * as Node fails them, so they reach the result paths of the code under test. One instance can be
 * shared by several handles and runs; faults are added and removed while it is in use.
 *
 * Paths are matched relative to the library folder given, with `/` (the library itself is `.`). A
 * rename is matched on its destination; `write` and `sync` on the path the handle was opened with.
 * A folder is never really opened, since Windows cannot open one for reading: its flush (`sync`) is
 * only checked against the faults, so tests that inject a non-Windows platform run alike on every
 * system. Test-only: it lives outside `src/`.
 */

export type FaultOperation =
  | "open"
  | "write"
  | "sync"
  | "rename"
  | "unlink"
  | "mkdir"
  | "rmdir"
  | "stat"
  | "lstat";

export interface Fault {
  operation: FaultOperation;
  /** The library path the call is on, or a test of it. */
  path: string | ((path: string) => boolean);
  /** The errno code of the error, for example `EIO` or `ENOSPC`. */
  errno: string;
  /** How many matching calls succeed before the fault fires. Default: 0. */
  skip?: number;
  /** How many matching calls fail once it fires. Default: 1; `Infinity` fails every one. */
  times?: number;
}

export interface FaultyFs {
  fs: FileSystem;
  /** Adds a fault; it is checked after the ones added before it. */
  inject(fault: Fault): void;
  /** Removes every fault, so every call succeeds from now on. */
  clear(): void;
  /** Every fault that fired, in order, as `<operation> <path> <errno>`. */
  fired: string[];
  /** Every call that changes the disk (`rename`, `unlink`, `mkdir`, `rmdir`), in order, as `<operation> <path>`. */
  changes: string[];
}

interface Armed extends Fault {
  seen: number;
  failed: number;
}

/** An error as Node gives it: an errno code, and a message that names the absolute path. */
function nodeError(errno: string, operation: string, path: string): Error {
  return Object.assign(new Error(`${errno}: injected fault, ${operation} '${path}'`), {
    code: errno,
    syscall: operation,
    path,
  });
}

export function faultyFs(library: string, base: FileSystem = realFileSystem): FaultyFs {
  let faults: Armed[] = [];
  const fired: string[] = [];
  const changes: string[] = [];
  const rel = (path: unknown): string => {
    const inside = relative(library, String(path)).split(sep).join("/");
    return inside === "" ? "." : inside;
  };
  /** Throws the first armed fault that matches this call. */
  const check = (operation: FaultOperation, path: unknown): void => {
    const name = rel(path);
    for (const fault of faults) {
      if (fault.operation !== operation) continue;
      if (typeof fault.path === "string" ? fault.path !== name : !fault.path(name)) continue;
      fault.seen += 1;
      if (fault.seen <= (fault.skip ?? 0) || fault.failed >= (fault.times ?? 1)) continue;
      fault.failed += 1;
      fired.push(`${operation} ${name} ${fault.errno}`);
      throw nodeError(fault.errno, operation, String(path));
    }
  };

  const fs: FileSystem = {
    ...base,
    open: (async (...args: Parameters<FileSystem["open"]>) => {
      const [path] = args;
      check("open", path);
      const folder = await base.stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (folder) {
        return {
          sync: async () => check("sync", path),
          close: async () => undefined,
        };
      }
      const handle = await base.open(...args);
      const sync = handle.sync.bind(handle);
      const writeFile = handle.writeFile.bind(handle);
      Object.assign(handle, {
        sync: async () => {
          check("sync", path);
          return sync();
        },
        writeFile: async (...data: Parameters<typeof handle.writeFile>) => {
          check("write", path);
          return writeFile(...data);
        },
      });
      return handle;
    }) as FileSystem["open"],
    rename: async (from, to) => {
      check("rename", to);
      changes.push(`rename ${rel(to)}`);
      return base.rename(from, to);
    },
    unlink: async (path) => {
      check("unlink", path);
      changes.push(`unlink ${rel(path)}`);
      return base.unlink(path);
    },
    mkdir: (async (...args: Parameters<FileSystem["mkdir"]>) => {
      check("mkdir", args[0]);
      changes.push(`mkdir ${rel(args[0])}`);
      return base.mkdir(...args);
    }) as FileSystem["mkdir"],
    rmdir: async (...args: Parameters<FileSystem["rmdir"]>) => {
      check("rmdir", args[0]);
      changes.push(`rmdir ${rel(args[0])}`);
      return base.rmdir(...args);
    },
    stat: (async (...args: Parameters<FileSystem["stat"]>) => {
      check("stat", args[0]);
      return base.stat(...args);
    }) as FileSystem["stat"],
    lstat: (async (...args: Parameters<FileSystem["lstat"]>) => {
      check("lstat", args[0]);
      return base.lstat(...args);
    }) as FileSystem["lstat"],
  };

  return {
    fs,
    inject: (fault) => void faults.push({ ...fault, seen: 0, failed: 0 }),
    clear: () => {
      faults = [];
    },
    fired,
    changes,
  };
}
