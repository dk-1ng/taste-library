import type { z } from "zod";
import type { FileKind, LibraryFileKind } from "../format.js";
import type { FileValue } from "../json/canonical.js";
import { DirectionId, GuardrailId, PinId, RefId, Slug } from "../schemas/v1/shared.js";
import type { Snapshot } from "../validation/library.js";
import { type FileChange, type Plan, type Skipped, skipReasonOf } from "./plan.js";
import {
  pieceMatcher,
  withoutDirectionLink,
  withoutFamilyLink,
  withoutGuardrailLink,
  withoutPieceLinks,
} from "./remove-links.js";

/**
 * Deletion plans (format-spec §5, §14; docs/design.md section 4, "Links to files with errors"):
 * the primary change first (the deletion itself, the user's decision), then the removal of every
 * link to the deleted thing, one change per file that holds one, sorted by path. Pure: a snapshot
 * in, a plan out; the write pipeline checks and writes it.
 *
 * - A file that may hold a link but is not `valid` is left alone and listed in `skipped` with its
 *   status, and so is a folder that could not be listed and may hold such files, with `unreadable`.
 * - When the thing to delete is already gone, the plan removes only the links left over (a
 *   deletion that stopped partway runs again to completion); with none left it changes nothing.
 * - When the file that holds the thing has errors, or lies in a folder that could not be listed,
 *   whether the thing exists is unknown, so the plan is blocked by that file (`blockedBy`).
 */

type Value = Record<string, unknown>;

/** Throws, as a bug, when `id` is not a well-formed identifier: callers validate their input first. */
function assertId(schema: z.ZodType<string>, id: string, what: string): void {
  if (!schema.safeParse(id).success) throw new Error(`"${id}" is not a ${what}.`);
}

type Target = { state: "valid"; value: unknown } | { state: "absent" } | { state: "unknown" };

/** The file that holds the thing to delete: usable, gone, or of unknown content. */
function target(snapshot: Snapshot, path: string): Target {
  const file = snapshot.files.get(path);
  if (file !== undefined) {
    return file.status === "valid" ? { state: "valid", value: file.value } : { state: "unknown" };
  }
  const unlisted = snapshot.unlistedFolders.some((folder) => path.startsWith(`${folder}/`));
  return unlisted ? { state: "unknown" } : { state: "absent" };
}

/** The folder each kind of file that holds links lives under; top-level files have none. */
const FOLDER_OF: Partial<Record<LibraryFileKind, string>> = {
  family: "families",
  directions: "projects",
  reference: "references",
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One change per file of the `holders` kinds that `remove` changes, sorted by path, and the files
 * and unlisted folders skipped. `remove` returns the new value, or `null` when the file holds no
 * link.
 */
function removeLinks(
  snapshot: Snapshot,
  holders: readonly LibraryFileKind[],
  remove: (kind: LibraryFileKind, value: unknown) => unknown,
): { changes: FileChange[]; skipped: Skipped[] } {
  const changes: FileChange[] = [];
  const skipped: Skipped[] = [];
  // A kind of another format version is never one of the version 1 holders.
  const isHolder = (kind: FileKind): kind is LibraryFileKind =>
    (holders as readonly FileKind[]).includes(kind);
  for (const [path, file] of snapshot.files) {
    const kind = file.kind;
    if (!isHolder(kind)) continue;
    const reason = skipReasonOf(file.status);
    if (reason !== null) {
      skipped.push({ path, reason });
      continue;
    }
    const next = remove(kind, file.value);
    if (next !== null) changes.push({ path, next });
  }
  const folders = holders.flatMap((kind) => FOLDER_OF[kind] ?? []);
  for (const folder of snapshot.unlistedFolders) {
    if (folders.some((base) => folder === base || folder.startsWith(`${base}/`))) {
      skipped.push({ path: folder, reason: "unreadable" });
    }
  }
  changes.sort((a, b) => compareText(a.path, b.path));
  skipped.sort((a, b) => compareText(a.path, b.path));
  return { changes, skipped };
}

/** The plan: the primary change (if any) first, then the link removals; `blockedBy` only when needed. */
function planOf(
  primary: FileChange | null,
  blockedBy: string | null,
  links: { changes: FileChange[]; skipped: Skipped[] },
): Plan {
  const plan: Plan = {
    changes: primary === null ? links.changes : [primary, ...links.changes],
    skipped: links.skipped,
  };
  if (blockedBy !== null) plan.blockedBy = [blockedBy];
  return plan;
}

/** Files whose `PieceRef` links can point to a pin or a reference (format-spec §14). */
const PIECE_HOLDERS: readonly LibraryFileKind[] = [
  "family",
  "glossary",
  "guardrails",
  "taste-profile",
  "directions",
];

/**
 * Deletes the pin `pinId` of the reference `refId`: the reference loses the pin and its
 * interpretation (its `lastIssued` is kept, so the number is never issued again, format-spec
 * §4.3), then every link to the piece is removed.
 */
export function planPinDeletion(snapshot: Snapshot, refId: string, pinId: string): Plan {
  assertId(RefId, refId, "reference id");
  assertId(PinId, pinId, "pin id");
  const path = `references/${refId}.json`;
  const file = target(snapshot, path);
  let primary: FileChange | null = null;
  if (file.state === "valid") {
    const reference = file.value as FileValue<"reference">;
    if (reference.pins.some((pin) => pin.id === pinId)) {
      const { [pinId]: _removed, ...interpretations } = reference.interpretations;
      primary = {
        path,
        next: {
          ...reference,
          pins: reference.pins.filter((pin) => pin.id !== pinId),
          interpretations,
        },
      };
    }
  }
  const matches = pieceMatcher(refId, pinId);
  return planOf(
    primary,
    file.state === "unknown" ? path : null,
    removeLinks(snapshot, PIECE_HOLDERS, (kind, value) => withoutPieceLinks(kind, value, matches)),
  );
}

/** Deletes a whole file (a reference, a family) as the primary change. */
function fileDeletion(
  snapshot: Snapshot,
  path: string,
  holders: readonly LibraryFileKind[],
  remove: (kind: LibraryFileKind, value: unknown) => unknown,
): Plan {
  const exists = snapshot.files.has(path);
  // A file with errors is still named for deletion: the pipeline refuses it with that file's issues.
  const primary: FileChange | null = exists ? { path, next: null } : null;
  const unknown = !exists && target(snapshot, path).state === "unknown";
  return planOf(primary, unknown ? path : null, removeLinks(snapshot, holders, remove));
}

/**
 * Deletes the reference `refId`: its file first, then every link to any of its pieces. Its folder
 * in the media folder is not touched here (#58 deletes it through the media write guard).
 */
export function planReferenceDeletion(snapshot: Snapshot, refId: string): Plan {
  assertId(RefId, refId, "reference id");
  const matches = pieceMatcher(refId);
  return fileDeletion(snapshot, `references/${refId}.json`, PIECE_HOLDERS, (kind, value) =>
    withoutPieceLinks(kind, value, matches),
  );
}

/** Deletes the family `slug`: its file first, then `direction.family` becomes `null` where it named it. */
export function planFamilyDeletion(snapshot: Snapshot, slug: string): Plan {
  assertId(Slug, slug, "slug");
  return fileDeletion(snapshot, `families/${slug}.json`, ["directions"], (_kind, value) =>
    withoutFamilyLink(value as FileValue<"directions">, slug),
  );
}

/**
 * Deletes the entry `id` from the list `field` of the file `path` (kept, even when it becomes
 * empty, and with its `lastIssued`), as the primary change.
 */
function entryDeletion(
  snapshot: Snapshot,
  path: string,
  field: string,
  id: string,
  links: { changes: FileChange[]; skipped: Skipped[] },
): Plan {
  const file = target(snapshot, path);
  let primary: FileChange | null = null;
  if (file.state === "valid") {
    const value = file.value as Value;
    const entries = value[field] as { id: string }[];
    if (entries.some((entry) => entry.id === id)) {
      primary = { path, next: { ...value, [field]: entries.filter((entry) => entry.id !== id) } };
    }
  }
  return planOf(primary, file.state === "unknown" ? path : null, links);
}

/** Deletes the guardrail `id`: its entry in `guardrails.json` first, then its links in directions. */
export function planGuardrailDeletion(snapshot: Snapshot, id: string): Plan {
  assertId(GuardrailId, id, "guardrail id");
  const links = removeLinks(snapshot, ["directions"], (_kind, value) =>
    withoutGuardrailLink(value as FileValue<"directions">, id),
  );
  return entryDeletion(snapshot, "guardrails.json", "guardrails", id, links);
}

/**
 * Deletes the direction `directionId` of the project `project`: its entry in the project's
 * `directions.json` first (its `lastIssued` is kept, so the number is never issued again), then
 * `result.direction` becomes `null` in the references that named it.
 */
export function planDirectionDeletion(
  snapshot: Snapshot,
  project: string,
  directionId: string,
): Plan {
  assertId(Slug, project, "slug");
  assertId(DirectionId, directionId, "direction id");
  const links = removeLinks(snapshot, ["reference"], (_kind, value) =>
    withoutDirectionLink(value as FileValue<"reference">, project, directionId),
  );
  return entryDeletion(
    snapshot,
    `projects/${project}/directions.json`,
    "directions",
    directionId,
    links,
  );
}
