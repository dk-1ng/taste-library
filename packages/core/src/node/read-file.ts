import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { type Issue, makeIssue } from "../validation/issue.js";

/** A JSON file over this size is not parsed (format-spec §3.2). */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

export type FileBytes =
  | { status: "ok"; bytes: Uint8Array }
  /** The file does not exist (it may have been deleted since it was listed). */
  | { status: "missing" }
  | { status: "failed"; issue: Issue };

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/**
 * Reads a library file through one handle: the size check and the read share it, so a symbolic
 * link or a change in between cannot get past the limit. `file` is the path relative to the
 * library, used in issues; `path` is where to read.
 */
export async function readLibraryFileBytes(path: string, file: string): Promise<FileBytes> {
  const tooLarge = (): FileBytes => ({
    status: "failed",
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
      const info = await handle.stat();
      if (!info.isFile()) {
        return {
          status: "failed",
          issue: makeIssue("unreadable-file", file, null, "The path is not a regular file."),
        };
      }
      if (info.size > MAX_JSON_BYTES) return tooLarge();
      // One byte more than the file had, so a file that grew meanwhile is noticed.
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_JSON_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_JSON_BYTES) return tooLarge();
      return { status: "ok", bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, length) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return {
      status: "failed",
      issue: makeIssue(
        "unreadable-file",
        file,
        null,
        `The file cannot be read (${errorCode(error)}).`,
      ),
    };
  }
}
