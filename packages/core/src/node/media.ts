import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import { readLibraryJson } from "../json/read.js";
import { versionOf } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import { validateValue } from "../validation/zod-issues.js";
import { mapLimit } from "./map-limit.js";
import { resolveMediaPath } from "./media-path.js";
import { readLibraryFileBytes } from "./read-file.js";

/**
 * Checking the media folder (docs/design.md section 4; format-spec §6, §16): the marker, each
 * file a reference lists (size, and with `checksums` the SHA-256) and the files nothing lists.
 * Media that has not arrived is "awaiting sync", never an error. Files are only read, never
 * rewritten.
 */

const MARKER_FILE = "tastelib-media.json";
const MARKER_REPORT_FILE = `media:${MARKER_FILE}`;
const CONCURRENCY = 8;
const REF_FOLDER = /^ref-\d{8}-[0-9a-hjkmnp-tv-z]{6}$/;

export interface MediaCheckOptions {
  /** Hash every media file instead of comparing sizes only (`--checksums`). */
  checksums?: boolean;
  registry?: FormatRegistry;
}

interface Listed {
  path: string;
  bytes: number;
  sha256: string;
}

const mediaFile = (path: string): string => `media:${path}`;

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

/** Every media file and frame the valid references list, once each, and the references that could not be read. */
function listedMedia(snapshot: Snapshot): {
  listed: Map<string, Listed>;
  unknownRefs: Set<string>;
} {
  const listed = new Map<string, Listed>();
  const unknownRefs = new Set<string>();
  const add = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null) return;
    const { file, bytes, sha256 } = entry as Record<string, unknown>;
    if (typeof file === "string" && typeof bytes === "number" && typeof sha256 === "string") {
      listed.set(file, { path: file, bytes, sha256 });
    }
  };
  for (const [path, file] of snapshot.files) {
    if (file.kind !== "reference") continue;
    if (file.status !== "valid" || typeof file.value !== "object" || file.value === null) {
      unknownRefs.add(path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, ""));
      continue;
    }
    const media = (file.value as { media?: unknown }).media;
    for (const item of Array.isArray(media) ? media : []) {
      add(item);
      const frames = (item as { frames?: unknown } | null)?.frames;
      for (const frame of Array.isArray(frames) ? frames : []) add(frame);
    }
  }
  return { listed, unknownRefs };
}

/**
 * Reads the marker. Returns its issues, and whether the file checks go on (`false` when the
 * marker names another library).
 */
async function checkMarker(
  folder: string,
  snapshot: Snapshot,
  registry: FormatRegistry,
): Promise<{ issues: Issue[]; proceed: boolean }> {
  const read = await readLibraryFileBytes(join(folder, MARKER_FILE), MARKER_REPORT_FILE);
  if (read.status === "missing") {
    return {
      issues: [
        makeIssue(
          "media-marker-missing",
          MARKER_REPORT_FILE,
          null,
          `The media folder has no ${MARKER_FILE}, so it is not known which library it belongs to.`,
        ),
      ],
      proceed: true,
    };
  }
  if (read.status === "failed") return { issues: [read.issue], proceed: true };
  const json = readLibraryJson(read.bytes, MARKER_REPORT_FILE);
  if (!json.ok) return { issues: json.issues, proceed: true };

  const version = versionOf(json.value);
  if (version !== null && version > registry.current) {
    return {
      issues: [
        makeIssue(
          "newer-format",
          MARKER_REPORT_FILE,
          "/formatVersion",
          `formatVersion: ${version} is newer than ${registry.current}, the newest version this tool supports; update the tool. The marker was not checked further.`,
        ),
      ],
      proceed: true,
    };
  }
  const spec = registry.versions[version ?? registry.current];
  const schema = (spec ?? registry.versions[registry.current])?.schemas.marker;
  if (schema === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  const issues = validateValue(schema, json.value, MARKER_REPORT_FILE);
  if (issues.length > 0) return { issues, proceed: true };

  const library = snapshot.files.get("library.json");
  const libraryId =
    library?.status === "valid" ? (library.value as { id?: unknown } | null)?.id : undefined;
  const markerId = (json.value as { libraryId: string }).libraryId;
  if (typeof libraryId === "string" && libraryId !== markerId) {
    return {
      issues: [
        makeIssue(
          "media-folder-mismatch",
          MARKER_REPORT_FILE,
          "/libraryId",
          "libraryId: the media folder belongs to another library, so its files were not checked; the wrong folder may be attached.",
        ),
      ],
      proceed: false,
    };
  }
  return { issues: [], proceed: true };
}

/** Size, and optionally the SHA-256, of the file at `real`; reads through one handle. */
async function measure(
  real: string,
  checksums: boolean,
): Promise<{ regular: false } | { regular: true; bytes: number; sha256: string | null }> {
  const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { regular: false };
    if (!checksums) return { regular: true, bytes: info.size, sha256: null };
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { regular: true, bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function checkListed(folder: string, entry: Listed, checksums: boolean): Promise<Issue[]> {
  const file = mediaFile(entry.path);
  const resolved = await resolveMediaPath(folder, entry.path);
  if (resolved.status === "missing") {
    return [
      makeIssue(
        "awaiting-sync",
        file,
        null,
        "The media file has not arrived on this computer yet; it may still be syncing.",
      ),
    ];
  }
  if (resolved.status === "outside") {
    return [
      makeIssue(
        "media-outside-folder",
        file,
        null,
        "The media path leads outside the media folder, so the file was not read.",
      ),
    ];
  }
  if (resolved.status === "failed") {
    return [
      makeIssue("unreadable-file", file, null, `The media file cannot be read (${resolved.code}).`),
    ];
  }
  let measured: Awaited<ReturnType<typeof measure>>;
  try {
    measured = await measure(resolved.path, checksums);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") {
      return [
        makeIssue(
          "awaiting-sync",
          file,
          null,
          "The media file has not arrived on this computer yet; it may still be syncing.",
        ),
      ];
    }
    return [makeIssue("unreadable-file", file, null, `The media file cannot be read (${code}).`)];
  }
  if (!measured.regular) {
    return [makeIssue("media-mismatch", file, null, "The media path is not a regular file.")];
  }
  if (measured.bytes !== entry.bytes) {
    return [
      makeIssue(
        "media-mismatch",
        file,
        null,
        `The file has ${measured.bytes} bytes but the reference lists ${entry.bytes}; it may be half-synced or damaged.`,
      ),
    ];
  }
  if (measured.sha256 !== null && measured.sha256 !== entry.sha256) {
    return [
      makeIssue(
        "media-mismatch",
        file,
        null,
        "The file's SHA-256 differs from the one the reference lists; it may be damaged.",
      ),
    ];
  }
  return [];
}

/** Files in a `<ref-id>/` folder of the media folder that no reference lists. */
async function orphanIssues(
  folder: string,
  listed: ReadonlyMap<string, Listed>,
  unknownRefs: ReadonlySet<string>,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  let top: Dirent[];
  try {
    top = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    return [
      makeIssue(
        "unreadable-file",
        null,
        null,
        `The media folder cannot be read (${errnoOf(error)}).`,
      ),
    ];
  }
  const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of [...top].sort(byName)) {
    const ref = entry.name.normalize("NFC");
    // A reference that could not be read may list files here: they are not known to be orphans.
    if (!REF_FOLDER.test(ref) || unknownRefs.has(ref)) continue;
    let children: Dirent[];
    try {
      if (!(await stat(join(folder, entry.name))).isDirectory()) continue;
      children = await readdir(join(folder, entry.name), { withFileTypes: true });
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      issues.push(
        makeIssue(
          "unreadable-file",
          mediaFile(ref),
          null,
          `The media folder cannot be read (${code}).`,
        ),
      );
      continue;
    }
    for (const child of [...children].sort(byName)) {
      if (child.isDirectory()) continue;
      const path = `${ref}/${child.name.normalize("NFC")}`;
      if (!listed.has(path)) {
        issues.push(
          makeIssue("orphan-media", mediaFile(path), null, "No reference lists this media file."),
        );
      }
    }
  }
  return issues;
}

/**
 * Checks the media folder against the snapshot of the library. Pass the result to `reportOf`; a
 * library with no media folder set reports `media-not-checked` instead.
 */
export async function checkMedia(
  snapshot: Snapshot,
  mediaFolder: string,
  options: MediaCheckOptions = {},
): Promise<Issue[]> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  try {
    if (!(await stat(mediaFolder)).isDirectory())
      throw Object.assign(new Error(), { code: "ENOTDIR" });
  } catch (error) {
    return [
      makeIssue(
        "unreadable-file",
        null,
        null,
        `The media folder cannot be read (${errnoOf(error)}), so media files were not checked.`,
      ),
    ];
  }
  const marker = await checkMarker(mediaFolder, snapshot, registry);
  if (!marker.proceed) return marker.issues;

  const { listed, unknownRefs } = listedMedia(snapshot);
  // If references/ could not be listed, which files are listed is unknown: nothing is an orphan.
  const referencesUnlisted = snapshot.issues.some(
    (issue) => issue.code === "unreadable-file" && issue.file === "references",
  );
  const perFile = await mapLimit([...listed.values()], CONCURRENCY, (entry) =>
    checkListed(mediaFolder, entry, options.checksums === true),
  );
  return [
    ...marker.issues,
    ...perFile.flat(),
    ...(referencesUnlisted ? [] : await orphanIssues(mediaFolder, listed, unknownRefs)),
  ];
}
