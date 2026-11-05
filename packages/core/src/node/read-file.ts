import { type BigIntStats, constants } from "node:fs";
import { open } from "node:fs/promises";
import { type Issue, makeIssue } from "../validation/issue.js";

/** A JSON file over this size is not parsed (format-spec §3.2). */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * What reading a file gave. `stats` is the stat of the handle that was read (`bigint: true`), so a
 * fingerprint always describes the very file whose bytes were read (docs/design.md section 4,
 * "Index", "Freshness"); `file-too-large` has it too, so an unchanged large file is not opened again.
 */
export type FileBytes =
  | { status: "ok"; bytes: Uint8Array; stats: BigIntStats }
  /** The file does not exist (it may have been deleted since it was listed). */
  | { status: "missing" }
  | { status: "failed"; issue: Issue; stats?: BigIntStats };

/**
 * Reads a library file through one handle: the size check and the read share it, so a symbolic
 * link or a change in between cannot get past the limit. `file` is the path relative to the
 * library, used in issues; `path` is where to read.
 */
export async function readLibraryFileBytes(path: string, file: string): Promise<FileBytes> {
  const tooLarge = (stats: BigIntStats): FileBytes => ({
    status: "failed",
    stats,
    issue: makeIssue(
      "file-too-large",
      file,
      null,
      `The file is larger than ${MAX_JSON_BYTES} bytes (8 MiB) and was not read.`,
    ),
  });
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) {
        return {
          status: "failed",
          issue: makeIssue("unreadable-file", file, null, "The path is not a regular file."),
        };
      }
      if (info.size > BigInt(MAX_JSON_BYTES)) return tooLarge(info);
      // Read until the end of the file, never past the limit plus one byte, so a file that grew
      // after the size check is read whole (or reported too large), never returned as a prefix.
      let buffer = Buffer.alloc(Math.min(Number(info.size) + 1, MAX_JSON_BYTES + 1));
      let length = 0;
      while (true) {
        if (length === buffer.length) {
          if (buffer.length > MAX_JSON_BYTES) return tooLarge(info);
          const larger = Buffer.alloc(Math.min(buffer.length * 2, MAX_JSON_BYTES + 1));
          buffer.copy(larger, 0, 0, length);
          buffer = larger;
        }
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return {
        status: "ok",
        bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, length),
        stats: info,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // An error without an errno code (or a Node argument error, ERR_*) is a bug, not an unreadable file: fail loudly.
    if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
    if (code === "ENOENT") return { status: "missing" };
    return {
      status: "failed",
      issue: makeIssue("unreadable-file", file, null, `The file cannot be read (${code}).`),
    };
  }
}
