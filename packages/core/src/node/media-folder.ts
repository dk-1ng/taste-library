import { lstat, mkdir, readdir, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readLibraryJson } from "../json/read.js";
import { MARKER_REGISTRY, type MarkerRegistry, migrateMarker, serializeMarker } from "../marker.js";
import { versionOf } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import { validateValue } from "../validation/zod-issues.js";
import { findGitWorkTree, isInside } from "./folders.js";
import { readLibraryFileBytes } from "./read-file.js";
import { type IoFailure, replaceFile, type WriteOptions } from "./replace-file.js";

/**
 * Attaching a media folder to a library, and the guard every media write calls first
 * (docs/design.md section 4, "Attaching a media folder"; format-spec §6.1, §15.1). Expected
 * failures are returned, never thrown.
 */

export const MARKER_FILE = "tastelib-media.json";
const MARKER_REPORT_FILE = `media:${MARKER_FILE}`;

/** Entries an operating system, a file manager or a sync client puts in a folder by itself (lower case, NFC). */
const IGNORABLE = new Set(
  [
    ".DS_Store",
    ".localized",
    "Icon\r",
    "desktop.ini",
    "Thumbs.db",
    ".directory",
    ".dropbox",
    ".dropbox.attr",
    ".dropbox.cache",
    ".stfolder",
    "System Volume Information",
    "$RECYCLE.BIN",
    ".Spotlight-V100",
    ".fseventsd",
    ".Trashes",
    ".TemporaryItems",
  ].map((name) => name.normalize("NFC").toLowerCase()),
);
/** The temporary file of an interrupted marker write. */
const MARKER_TEMP = /^\.tastelib-media\.json\.tmp-[0-9a-hjkmnp-tv-z]{8}$/;

/** Whether a folder's entry is one of those that do not make the folder "not empty". */
export function isIgnorableEntry(name: string): boolean {
  const folded = name.normalize("NFC").toLowerCase();
  return IGNORABLE.has(folded) || MARKER_TEMP.test(folded);
}

export type AttachRefusalCode =
  | "not-a-folder"
  | "media-inside-library"
  | "library-inside-media"
  | "media-inside-git"
  | "media-marker-unreadable"
  | "media-folder-mismatch"
  | "newer-format"
  | "media-folder-not-empty"
  | "parent-folder-missing";

export interface AttachLibrary {
  /** The library folder. */
  path: string;
  /** The `id` of its (valid) `library.json`. */
  id: string;
}

export interface AttachOptions {
  markerRegistry?: MarkerRegistry;
  /** Passed to the marker write (file system, hooks). */
  write?: Omit<WriteOptions, "expected" | "file">;
  platform?: NodeJS.Platform;
}

export type AttachResult =
  | {
      status: "attached";
      folder: string;
      /** `written`: a new marker; `kept`: this library's marker; `migrated`: an older marker brought up to date on disk. */
      marker: "written" | "kept" | "migrated";
      notices: { code: "media-already-attached" }[];
    }
  | {
      status: "refused";
      code: AttachRefusalCode | "write-conflict";
      message: string;
      issues: Issue[];
    }
  | { status: "failed"; failure: IoFailure };

function ioFailure(operation: string, file: string, error: unknown): IoFailure {
  const errno = (error as { code?: unknown } | null)?.code;
  if (typeof errno !== "string" || errno.startsWith("ERR_")) throw error;
  return { code: "io-error", operation, file, errno, message: `${operation} failed (${errno})` };
}

type MarkerState =
  | { status: "missing" }
  | { status: "unreadable"; issues: Issue[] }
  | { status: "newer"; version: number }
  | { status: "mismatch"; libraryId: string }
  | {
      status: "ok";
      /** The marker at the current version (migrated in memory when older). */
      value: unknown;
      /** The version on disk. */
      version: number;
      bytes: Uint8Array;
    };

/**
 * Reads the marker of a media folder and checks it against the library's id. An older marker is
 * migrated **in memory only**: this is the path for read-only commands. Nothing is written.
 */
export async function readMarker(
  folder: string,
  libraryId: string,
  registry: MarkerRegistry = MARKER_REGISTRY,
): Promise<MarkerState> {
  const read = await readLibraryFileBytes(join(folder, MARKER_FILE), MARKER_REPORT_FILE);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "failed") return { status: "unreadable", issues: [read.issue] };
  const json = readLibraryJson(read.bytes, MARKER_REPORT_FILE);
  if (!json.ok) return { status: "unreadable", issues: json.issues };
  const version = versionOf(json.value);
  if (version !== null && version > registry.current) return { status: "newer", version };
  const schema = registry.versions[version ?? registry.current]?.schema;
  if (version === null || schema === undefined) {
    const fallback = registry.versions[registry.current]?.schema;
    if (fallback === undefined) throw new Error(`The registry has no version ${registry.current}.`);
    return {
      status: "unreadable",
      issues: validateValue(fallback, json.value, MARKER_REPORT_FILE),
    };
  }
  const issues = validateValue(schema, json.value, MARKER_REPORT_FILE);
  if (issues.length > 0) return { status: "unreadable", issues };
  const migrated = migrateMarker(registry, json.value, version);
  if (!migrated.ok) {
    return {
      status: "unreadable",
      issues: [makeIssue("schema-violation", MARKER_REPORT_FILE, null, migrated.reason)],
    };
  }
  const markerId = (migrated.value as { libraryId: string }).libraryId;
  if (markerId !== libraryId) return { status: "mismatch", libraryId: markerId };
  return { status: "ok", value: migrated.value, version, bytes: read.bytes };
}

async function migrateOnDisk(
  folder: string,
  state: Extract<MarkerState, { status: "ok" }>,
  registry: MarkerRegistry,
  options: AttachOptions["write"],
): Promise<IoFailure | "conflict" | null> {
  const outcome = await replaceFile(
    join(folder, MARKER_FILE),
    new TextEncoder().encode(serializeMarker(registry, state.value)),
    { ...options, expected: state.bytes, file: MARKER_REPORT_FILE },
  );
  if (outcome.status === "done") return null;
  return outcome.status === "write-conflict" ? "conflict" : outcome.failure;
}

const CONFLICT_MESSAGE =
  "The marker changed while it was being written, so nothing was replaced. Read it again and retry.";
const conflictIssue = (): Issue =>
  makeIssue("write-conflict", MARKER_REPORT_FILE, null, CONFLICT_MESSAGE);

/**
 * Attaches `path` as the media folder of `library`: runs the checks in the order of docs/design.md
 * section 4, then creates the folder when missing and writes the marker. A refusal writes nothing.
 */
export async function attachMediaFolder(
  library: AttachLibrary,
  path: string,
  options: AttachOptions = {},
): Promise<AttachResult> {
  const registry = options.markerRegistry ?? MARKER_REGISTRY;
  const platform = options.platform ?? process.platform;
  const refuse = (
    code: AttachRefusalCode | "write-conflict",
    message: string,
    issues: Issue[] = [],
  ): AttachResult => ({ status: "refused", code, message, issues });
  const failed = (operation: string, error: unknown, file = "media:"): AttachResult => ({
    status: "failed",
    failure: ioFailure(operation, file, error),
  });

  // 1. Not a folder.
  let exists = true;
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return refuse(
        "not-a-folder",
        `${path} is not a folder. Choose or create an empty folder for media.`,
      );
    }
  } catch (error) {
    const errno = (error as { code?: unknown } | null)?.code;
    if (
      errno === "ENOENT" &&
      (await lstat(path).then(
        () => true,
        () => false,
      ))
    ) {
      // A link whose target is not there (for example a drive that is not mounted).
      return refuse(
        "not-a-folder",
        `${path} is a link to a folder that does not exist. Choose or create an empty folder for media.`,
      );
    }
    if (errno === "ENOENT") exists = false;
    else if (errno === "ENOTDIR") {
      return refuse(
        "not-a-folder",
        `${path} is not a folder. Choose or create an empty folder for media.`,
      );
    } else return failed("stat", error);
  }

  // 2. Inside the library folder, the folder itself included.
  const inside = await isInside(path, library.path, platform);
  if (inside.status === "failed") return failed("stat", { code: inside.errno });
  if (inside.contained) {
    return refuse(
      "media-inside-library",
      `${path} is inside the library folder ${library.path}. Media must stay out of the library's folder: the library is committed to Git, and media (captures of other people's work, large files) must never be. Choose or create an empty folder outside the library folder, for example next to it.`,
    );
  }

  // 3. Containing the library.
  if (exists) {
    const containing = await isInside(library.path, path, platform);
    if (containing.status === "failed")
      return failed("stat", { code: containing.errno }, "library:");
    if (containing.contained) {
      return refuse(
        "library-inside-media",
        `The library folder ${library.path} is inside ${path}. A media folder must not contain the library: the library's files would be mixed with the media and synced with them. Choose a folder that does not contain the library.`,
      );
    }
  }

  // 4. Inside a Git working tree.
  const git = await findGitWorkTree(path);
  if (git.status === "failed") return failed("lstat", { code: git.errno });
  if (git.status === "found") {
    return refuse(
      "media-inside-git",
      `${path} is inside the Git working tree at ${git.worktree}. Media must live outside every Git repository: the repository would grow with every capture, and captures of other people's work could be committed and published. Choose or create an empty folder outside any repository.`,
    );
  }

  // 5. The marker.
  let marker: "written" | "kept" | "migrated" = "written";
  let state: MarkerState = { status: "missing" };
  if (exists) {
    state = await readMarker(path, library.id, registry);
    if (state.status === "unreadable") {
      const first = state.issues[0]?.message ?? "it cannot be read";
      return refuse(
        "media-marker-unreadable",
        `The marker ${MARKER_FILE} in ${path} is damaged: ${first} Restore it from your sync service or another computer, or choose another folder.`,
        state.issues,
      );
    }
    if (state.status === "mismatch") {
      return refuse(
        "media-folder-mismatch",
        `${path} is the media folder of another library (${state.libraryId}). Two libraries must not share a media folder. Choose this library's media folder, or an empty folder.`,
        [
          makeIssue(
            "media-folder-mismatch",
            MARKER_REPORT_FILE,
            "/libraryId",
            "libraryId: the media folder belongs to another library.",
          ),
        ],
      );
    }
    if (state.status === "newer") {
      return refuse(
        "newer-format",
        `The marker in ${path} was written by a newer tastelib (marker format ${state.version}; this version supports up to ${registry.current}). Update tastelib, then attach it again.`,
        [
          makeIssue(
            "newer-format",
            MARKER_REPORT_FILE,
            "/formatVersion",
            `formatVersion: ${state.version} is newer than ${registry.current}, the newest version this tool supports.`,
          ),
        ],
      );
    }
  }

  // 6. Not empty and without a marker.
  if (exists && state.status === "missing") {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      return failed("readdir", error);
    }
    if (names.some((name) => !isIgnorableEntry(name))) {
      return refuse(
        "media-folder-not-empty",
        `${path} is not empty and has no ${MARKER_FILE} marker, so it is not a media folder of this library. tastelib does not take over a folder that holds other files, such as a downloads or pictures folder: it would then report and manage files that are not its own. Choose or create an empty folder, or move this folder's files out first. If this is your media folder and only its marker was lost, attach an empty folder and move the reference folders into it.`,
      );
    }
  }

  // 7. Parent missing.
  if (!exists) {
    try {
      // Where a file stands in the path, some systems say "not found" instead of "not a folder".
      if (!(await stat(dirname(path))).isDirectory()) {
        return refuse(
          "not-a-folder",
          `${dirname(path)} is not a folder. Choose or create an empty folder for media.`,
        );
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") {
        return refuse(
          "parent-folder-missing",
          `Neither ${path} nor its parent folder exists. Create the parent folder first, or choose another location.`,
        );
      }
      return failed("stat", error);
    }
  }

  // Write.
  if (state.status === "ok") {
    if (state.version === registry.current) {
      return {
        status: "attached",
        folder: path,
        marker: "kept",
        notices: [{ code: "media-already-attached" }],
      };
    }
    const migrated = await migrateOnDisk(path, state, registry, options.write);
    if (migrated === "conflict")
      return refuse("write-conflict", CONFLICT_MESSAGE, [conflictIssue()]);
    if (migrated !== null) return { status: "failed", failure: migrated };
    marker = "migrated";
    return {
      status: "attached",
      folder: path,
      marker,
      notices: [{ code: "media-already-attached" }],
    };
  }

  let created = false;
  if (!exists) {
    try {
      await mkdir(path);
      created = true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "EEXIST") return failed("mkdir", error);
    }
  }
  // A new marker is a version 1 marker brought to the current version by the same steps.
  const first = migrateMarker(registry, { formatVersion: 1, libraryId: library.id }, 1);
  if (!first.ok) throw new Error(first.reason);
  const fresh = serializeMarker(registry, first.value);
  const outcome = await replaceFile(join(path, MARKER_FILE), new TextEncoder().encode(fresh), {
    ...options.write,
    expected: "absent",
    file: MARKER_REPORT_FILE,
  });
  if (outcome.status !== "done") {
    if (created) await rmdir(path).catch(() => undefined);
    if (outcome.status === "failed") return { status: "failed", failure: outcome.failure };
    return refuse("write-conflict", CONFLICT_MESSAGE, [conflictIssue()]);
  }
  return { status: "attached", folder: path, marker: "written", notices: [] };
}

export type MediaGuardResult =
  | { status: "ok"; marker: "kept" | "migrated" }
  | {
      status: "refused";
      code:
        | "media-marker-missing"
        | "media-marker-unreadable"
        | "media-folder-mismatch"
        | "newer-format"
        | "write-conflict";
      issues: Issue[];
    }
  | { status: "failed"; failure: IoFailure };

/**
 * The guard every media write (a capture, a deletion) calls first: the marker exists, is valid,
 * names this library and is not newer than the tool. An older marker is migrated on disk. A newer
 * marker blocks media writes only; the library itself stays writable (format-spec §15.1).
 */
export async function guardMediaWrite(
  mediaFolder: string,
  libraryId: string,
  options: Pick<AttachOptions, "markerRegistry" | "write"> = {},
): Promise<MediaGuardResult> {
  const registry = options.markerRegistry ?? MARKER_REGISTRY;
  const state = await readMarker(mediaFolder, libraryId, registry);
  const refused = (
    code: "media-marker-missing" | "media-folder-mismatch" | "newer-format",
    pointer: string | null,
    message: string,
  ): MediaGuardResult => ({
    status: "refused",
    code,
    issues: [makeIssue(code, MARKER_REPORT_FILE, pointer, message)],
  });
  switch (state.status) {
    case "missing":
      return refused(
        "media-marker-missing",
        null,
        `The media folder has no ${MARKER_FILE}, so it is not known which library it belongs to.`,
      );
    case "unreadable":
      return { status: "refused", code: "media-marker-unreadable", issues: state.issues };
    case "mismatch":
      return refused(
        "media-folder-mismatch",
        "/libraryId",
        "libraryId: the media folder belongs to another library; the wrong folder may be attached.",
      );
    case "newer":
      return refused(
        "newer-format",
        "/formatVersion",
        `formatVersion: ${state.version} is newer than ${registry.current}, the newest version this tool supports; update the tool. Nothing is written to the media folder.`,
      );
    case "ok": {
      if (state.version === registry.current) return { status: "ok", marker: "kept" };
      const migrated = await migrateOnDisk(mediaFolder, state, registry, options.write);
      if (migrated === null) return { status: "ok", marker: "migrated" };
      if (migrated === "conflict") {
        return { status: "refused", code: "write-conflict", issues: [conflictIssue()] };
      }
      return { status: "failed", failure: migrated };
    }
  }
}
