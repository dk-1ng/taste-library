import type { FileKind } from "../format.js";
import type { FileValue } from "../json/canonical.js";
import {
  buildTargets,
  type LinkState,
  type LinkTarget,
  type Targets,
  targetFileOf,
} from "../library-index/targets.js";
import { type VersionSummary, versionSummary } from "../library-index/versions.js";
import { comparisonKey } from "../schemas/v1/shared.js";
import type { FileStatus } from "./file.js";
import { type Issue, makeIssue } from "./issue.js";
import { describePath, pointerOf } from "./zod-issues.js";

/**
 * The checks across files (docs/design.md section 4, "Links to files with errors"; format-spec
 * §14, §13.3, §13.4, §15.2). Pure: the parsed files in, issues out. SHA-256 is passed in as a
 * synchronous function, because the browser's `digest` is asynchronous (docs/design.md section 3).
 *
 * Only a file that is `valid` and at the current version takes part with its value: an older or
 * mixed library is checked on its migrated view (`validation/library.ts`), and when it has none
 * (the migration cannot run) an older file is neither checked for links nor a place where a link
 * can be found, so its links are unresolved.
 */

export interface CrossFile {
  kind: FileKind;
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
  /** Folders that exist but could not be listed: what lies under one is unknown, so a link into it is unresolved. */
  unlistedFolders?: readonly string[];
  /** The version summary of these files (`versionSummary`); built here when absent. */
  versions?: VersionSummary;
  /** The targets of these files (`buildTargets`); built here when absent. */
  targets?: Targets;
  /** Called once for every link of every usable file, resolved or not (the write pipeline uses it to find new links). */
  onLink?: (link: LinkEvent) => void;
}

/**
 * One link of a file. `holder` is what holds the link: the id of the entry (a term, guardrail,
 * statement or direction) or, for a link outside entries, the field (`members`, `result`), so a
 * link is "the same" when its holder and target are (docs/design.md section 4, "Writing library
 * files", layer 4). `target` names what it points to, for messages; `to` is the target itself.
 */
export interface LinkEvent {
  file: string;
  pointer: string;
  holder: string;
  target: string;
  to: LinkTarget;
  /** The file that should hold the target, relative to the library. */
  targetFile: string;
  /** `unresolved`: the target file exists but is not `valid`, so whether it holds the target is unknown. */
  state: LinkState;
}

type Path = (string | number)[];

export function crossFileIssues(
  files: ReadonlyMap<string, CrossFile>,
  options: CrossOptions,
): Issue[] {
  const issues: Issue[] = [];

  // ---- Versions (format-spec §15.2), from the version summary of the index ----
  const versions = options.versions ?? versionSummary(files, options.current);
  if (versions.needsMigration) {
    issues.push(
      makeIssue(
        "needs-migration",
        null,
        null,
        `The library is at format version ${versions.library} and this tool writes version ${options.current}; it is migrated in memory for reading and on disk before the first write.`,
      ),
    );
  }
  for (const path of versions.mixedFiles) {
    const file = files.get(path);
    issues.push(
      makeIssue(
        "mixed-format-versions",
        path,
        "/formatVersion",
        `formatVersion: ${file?.formatVersion} differs from ${versions.library}, the version in library.json; a write migrates the library first.`,
      ),
    );
  }

  // ---- Links (format-spec §14), resolved by the one rule of `library-index/targets.ts` ----
  const targets =
    options.targets ?? buildTargets(files, options.current, options.unlistedFolders ?? []);

  const link = (file: string, path: Path, holder: string, what: string, to: LinkTarget): void => {
    const state = targets.resolve(to);
    options.onLink?.({
      file,
      pointer: pointerOf(path) ?? "",
      holder,
      target: what,
      to,
      targetFile: targetFileOf(to),
      state,
    });
    if (state !== "dangling") return;
    issues.push(
      makeIssue(
        "dangling-link",
        file,
        pointerOf(path),
        `${describePath(path)}: ${what} does not exist.`,
      ),
    );
  };

  const checkPiece = (file: string, path: Path, holder: string, ref: string): void => {
    const [refId = "", pieceId = ""] = ref.split("#");
    link(file, path, holder, `piece ${ref}`, { kind: "piece", ref: refId, piece: pieceId });
  };

  for (const [path, file] of files) {
    if (file.status !== "valid" || file.formatVersion !== options.current) continue;
    switch (file.kind) {
      case "reference": {
        const reference = file.value as FileValue<"reference">;
        const result = reference.result;
        if (result !== null) {
          link(path, ["result", "project"], "result", `project "${result.project}"`, {
            kind: "project",
            slug: result.project,
          });
          if (result.direction !== null) {
            link(
              path,
              ["result", "direction"],
              "result",
              `direction ${result.direction} of project "${result.project}"`,
              { kind: "direction", project: result.project, id: result.direction },
            );
          }
        }
        staleProposals(path, reference, options.sha256, issues);
        break;
      }
      case "family": {
        const family = file.value as FileValue<"family">;
        family.members.forEach((member, index) => {
          checkPiece(path, ["members", index, "target"], "members", member.target);
        });
        break;
      }
      case "glossary": {
        const glossary = file.value as FileValue<"glossary">;
        glossary.terms.forEach((term, termIndex) => {
          term.pieces.forEach((ref, index) => {
            checkPiece(path, ["terms", termIndex, "pieces", index], term.id, ref);
          });
        });
        duplicateTerms(path, glossary, issues);
        break;
      }
      case "guardrails": {
        const guardrails = file.value as FileValue<"guardrails">;
        guardrails.guardrails.forEach((guardrail, guardrailIndex) => {
          guardrail.sources.forEach((ref, index) => {
            checkPiece(path, ["guardrails", guardrailIndex, "sources", index], guardrail.id, ref);
          });
        });
        break;
      }
      case "taste-profile": {
        const profile = file.value as FileValue<"taste-profile">;
        profile.statements.forEach((statement, statementIndex) => {
          statement.evidence.forEach((ref, index) => {
            checkPiece(path, ["statements", statementIndex, "evidence", index], statement.id, ref);
          });
        });
        break;
      }
      case "directions": {
        const directions = file.value as FileValue<"directions">;
        directions.directions.forEach((direction, directionIndex) => {
          const at: Path = ["directions", directionIndex];
          if (direction.family !== null) {
            link(path, [...at, "family"], direction.id, `family "${direction.family}"`, {
              kind: "family",
              slug: direction.family,
            });
          }
          direction.pieces.forEach((ref, index) => {
            checkPiece(path, [...at, "pieces", index], direction.id, ref);
          });
          direction.guardrails.forEach((id, index) => {
            link(path, [...at, "guardrails", index], direction.id, `guardrail ${id}`, {
              kind: "guardrail",
              id,
            });
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
