import type { FileValue } from "../json/canonical.js";
import { comparisonKey } from "../schemas/v1/shared.js";
import type { LibraryFileKind } from "../format.js";
import type { FileStatus } from "./file.js";
import { type Issue, makeIssue } from "./issue.js";
import { describePath, pointerOf } from "./zod-issues.js";

/**
 * The checks across files (docs/design.md section 4, "Links to files with errors"; format-spec
 * §14, §13.3, §13.4, §15.2). Pure: the parsed files in, issues out. SHA-256 is passed in as a
 * synchronous function, because the browser's `digest` is asynchronous (docs/design.md section 3).
 *
 * Only a file that is `valid` and at the current version takes part with its value. Migrating
 * older files in memory arrives with the migration runner (#38); until then an older file is
 * neither checked for links nor a place where a link can be found, so its links are unresolved.
 */

export interface CrossFile {
  kind: LibraryFileKind;
  status: FileStatus;
  formatVersion: number | null;
  /** The parsed value; present when the status is `valid`. */
  value: unknown;
}

export interface CrossOptions {
  /** The version this tool supports. */
  current: number;
  /** SHA-256 of the bytes, as 64 lowercase hex characters. */
  sha256: (bytes: Uint8Array) => string;
}

type Path = (string | number)[];

/** A file usable as the target or holder of a link: valid and at the current version. */
interface Usable<K extends LibraryFileKind> {
  value: FileValue<K>;
}

export function crossFileIssues(
  files: ReadonlyMap<string, CrossFile>,
  options: CrossOptions,
): Issue[] {
  const issues: Issue[] = [];
  const library = files.get("library.json");
  const libraryVersion =
    library !== undefined && (library.status === "valid" || library.status === "newer")
      ? library.formatVersion
      : null;

  // ---- Versions (format-spec §15.2) ----
  if (library?.status === "valid" && libraryVersion !== null && libraryVersion < options.current) {
    issues.push(
      makeIssue(
        "needs-migration",
        null,
        null,
        `The library is at format version ${libraryVersion} and this tool writes version ${options.current}; it is migrated in memory for reading and on disk before the first write.`,
      ),
    );
  }
  if (libraryVersion !== null) {
    for (const [path, file] of files) {
      if (path === "library.json") continue;
      if (file.status !== "valid" && file.status !== "invalid") continue;
      if (file.formatVersion !== null && file.formatVersion !== libraryVersion) {
        issues.push(
          makeIssue(
            "mixed-format-versions",
            path,
            "/formatVersion",
            `formatVersion: ${file.formatVersion} differs from ${libraryVersion}, the version in library.json; a write migrates the library first.`,
          ),
        );
      }
    }
  }

  // ---- Links (format-spec §14) ----
  const usable = <K extends LibraryFileKind>(
    path: string,
    kind: K,
  ): Usable<K> | "absent" | "unresolved" => {
    const file = files.get(path);
    if (file === undefined || file.kind !== kind) return "absent";
    if (file.status !== "valid" || file.formatVersion !== options.current) return "unresolved";
    return { value: file.value as FileValue<K> };
  };

  const pieceIds = new Map<string, Set<string> | "absent" | "unresolved">();
  const piecesOf = (refId: string): Set<string> | "absent" | "unresolved" => {
    let cached = pieceIds.get(refId);
    if (cached === undefined) {
      const target = usable(`references/${refId}.json`, "reference");
      cached =
        typeof target === "string"
          ? target
          : new Set(["p0", ...target.value.pins.map((pin) => pin.id)]);
      pieceIds.set(refId, cached);
    }
    return cached;
  };

  const dangling = (file: string, path: Path, what: string): void => {
    issues.push(
      makeIssue(
        "dangling-link",
        file,
        pointerOf(path),
        `${describePath(path)}: ${what} does not exist.`,
      ),
    );
  };

  const checkPiece = (file: string, path: Path, ref: string): void => {
    const [refId = "", pieceId = ""] = ref.split("#");
    const pieces = piecesOf(refId);
    if (pieces === "unresolved") return;
    if (pieces === "absent" || !pieces.has(pieceId)) dangling(file, path, `piece ${ref}`);
  };

  for (const [path, file] of files) {
    if (file.status !== "valid" || file.formatVersion !== options.current) continue;
    switch (file.kind) {
      case "reference": {
        const reference = file.value as FileValue<"reference">;
        const result = reference.result;
        if (result !== null) {
          if (usable(`projects/${result.project}/project.json`, "project") === "absent") {
            dangling(path, ["result", "project"], `project "${result.project}"`);
          }
          if (result.direction !== null) {
            const directions = usable(`projects/${result.project}/directions.json`, "directions");
            if (
              directions === "absent" ||
              (typeof directions !== "string" &&
                !directions.value.directions.some((entry) => entry.id === result.direction))
            ) {
              dangling(
                path,
                ["result", "direction"],
                `direction ${result.direction} of project "${result.project}"`,
              );
            }
          }
        }
        staleProposals(path, reference, options.sha256, issues);
        break;
      }
      case "family": {
        const family = file.value as FileValue<"family">;
        family.members.forEach((member, index) => {
          checkPiece(path, ["members", index, "target"], member.target);
        });
        break;
      }
      case "glossary": {
        const glossary = file.value as FileValue<"glossary">;
        glossary.terms.forEach((term, termIndex) => {
          term.pieces.forEach((ref, index) => {
            checkPiece(path, ["terms", termIndex, "pieces", index], ref);
          });
        });
        duplicateTerms(path, glossary, issues);
        break;
      }
      case "guardrails": {
        const guardrails = file.value as FileValue<"guardrails">;
        guardrails.guardrails.forEach((guardrail, guardrailIndex) => {
          guardrail.sources.forEach((ref, index) => {
            checkPiece(path, ["guardrails", guardrailIndex, "sources", index], ref);
          });
        });
        break;
      }
      case "taste-profile": {
        const profile = file.value as FileValue<"taste-profile">;
        profile.statements.forEach((statement, statementIndex) => {
          statement.evidence.forEach((ref, index) => {
            checkPiece(path, ["statements", statementIndex, "evidence", index], ref);
          });
        });
        break;
      }
      case "directions": {
        const directions = file.value as FileValue<"directions">;
        const guardrails = usable("guardrails.json", "guardrails");
        directions.directions.forEach((direction, directionIndex) => {
          const at: Path = ["directions", directionIndex];
          if (direction.family !== null) {
            if (usable(`families/${direction.family}.json`, "family") === "absent") {
              dangling(path, [...at, "family"], `family "${direction.family}"`);
            }
          }
          direction.pieces.forEach((ref, index) => {
            checkPiece(path, [...at, "pieces", index], ref);
          });
          direction.guardrails.forEach((id, index) => {
            if (guardrails === "unresolved") return;
            if (guardrails === "absent" || !guardrails.value.guardrails.some((g) => g.id === id)) {
              dangling(path, [...at, "guardrails", index], `guardrail ${id}`);
            }
          });
        });
        break;
      }
      default:
        break;
    }
  }
  return issues;
}

/** `proposal-stale` (format-spec §13.4): a proposal that is `to-review` or `accepted` over a note that has changed since. */
function staleProposals(
  file: string,
  reference: FileValue<"reference">,
  sha256: (bytes: Uint8Array) => string,
  issues: Issue[],
): void {
  const encoder = new TextEncoder();
  for (const [piece, interpretation] of Object.entries(reference.interpretations)) {
    if (interpretation.origin !== "agent") continue;
    if (interpretation.status !== "to-review" && interpretation.status !== "accepted") continue;
    const note =
      piece === "p0" ? reference.note : reference.pins.find((pin) => pin.id === piece)?.note;
    if (note === undefined) continue; // a link to no piece is `broken-local-link`, reported by the schema
    if (sha256(encoder.encode(note)) !== interpretation.inputSha256) {
      const path: Path = ["interpretations", piece, "inputSha256"];
      issues.push(
        makeIssue(
          "proposal-stale",
          file,
          pointerOf(path),
          `${describePath(path)}: the note of piece ${piece} changed after the proposal was made.`,
        ),
      );
    }
  }
}

/** `duplicate-term` (format-spec §9): two terms whose effective `term` compares equal, reported on the later one. */
function duplicateTerms(file: string, glossary: FileValue<"glossary">, issues: Issue[]): void {
  const first = new Map<string, number>();
  glossary.terms.forEach((term, index) => {
    const entry = term.entry;
    let field: "content" | "proposal" | "correction";
    let content: { term: string };
    if (entry.origin === "user") {
      field = "content";
      content = entry.content;
    } else if (entry.status === "rejected") {
      return; // no effective value: not in the glossary (format-spec §13.3)
    } else if (entry.status === "corrected") {
      field = "correction";
      content = entry.correction as { term: string };
    } else {
      field = "proposal"; // accepted, or to-review and tentative
      content = entry.proposal;
    }
    const key = comparisonKey(content.term);
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, index);
      return;
    }
    const path: Path = ["terms", index, "entry", field, "term"];
    issues.push(
      makeIssue(
        "duplicate-term",
        file,
        pointerOf(path),
        `${describePath(path)}: repeats the term of terms[${earlier}] (terms are compared without case or Unicode form).`,
      ),
    );
  });
}
