import type { LibraryFileKind } from "../format.js";
import type { FileValue } from "../json/canonical.js";
import type { CrossFile } from "../validation/cross.js";

/**
 * The targets of cross-file links and the one rule that resolves them (docs/design.md section 4,
 * "Links to files with errors"; format-spec §14). Pure. The cross-file checks and the index both
 * resolve links here, so the dangling check and the existence sets can never disagree.
 *
 * Only a file that is `valid` and at the current version is usable: an older or mixed library is
 * resolved on its migrated view (`validation/library.ts`), and without one a link into an older
 * file is unresolved.
 */

export type LinkTarget =
  | { kind: "piece"; ref: string; piece: string }
  | { kind: "family"; slug: string }
  | { kind: "project"; slug: string }
  | { kind: "direction"; project: string; id: string }
  | { kind: "guardrail"; id: string };

/** `unresolved`: the target file exists but is not usable, or lies in a folder that could not be listed. */
export type LinkState = "resolved" | "dangling" | "unresolved";

/** A stable text key for a target: `piece:<ref>#<piece>`, `family:<slug>`, `project:<slug>`, `direction:<project>/<id>`, `guardrail:<id>`. */
export function targetKey(target: LinkTarget): string {
  switch (target.kind) {
    case "piece":
      return `piece:${target.ref}#${target.piece}`;
    case "family":
      return `family:${target.slug}`;
    case "project":
      return `project:${target.slug}`;
    case "direction":
      return `direction:${target.project}/${target.id}`;
    case "guardrail":
      return `guardrail:${target.id}`;
  }
}

/** The file that should hold the target, relative to the library. */
export function targetFileOf(target: LinkTarget): string {
  switch (target.kind) {
    case "piece":
      return `references/${target.ref}.json`;
    case "family":
      return `families/${target.slug}.json`;
    case "project":
      return `projects/${target.slug}/project.json`;
    case "direction":
      return `projects/${target.project}/directions.json`;
    case "guardrail":
      return "guardrails.json";
  }
}

const KIND_OF_TARGET: Readonly<Record<LinkTarget["kind"], LibraryFileKind>> = {
  piece: "reference",
  family: "family",
  project: "project",
  direction: "directions",
  guardrail: "guardrails",
};

/**
 * The existence sets of the usable files (docs/design.md section 4, "Index"). They are about
 * files, not effective values: a family whose description is rejected still exists here.
 */
export interface Targets {
  /** Usable references, by id, with their piece ids (`p0`, then the pins in file order). */
  references: ReadonlyMap<string, ReadonlySet<string>>;
  /** Usable family files, by slug. */
  families: ReadonlySet<string>;
  /** Usable project files, by slug. */
  projects: ReadonlySet<string>;
  /** The direction ids of each project whose `directions.json` is usable. */
  directions: ReadonlyMap<string, ReadonlySet<string>>;
  /** The guardrail ids of a usable `guardrails.json`. */
  guardrails: ReadonlySet<string>;
  resolve(target: LinkTarget): LinkState;
}

const REFERENCE = /^references\/([^/]+)\.json$/;
const FAMILY = /^families\/([^/]+)\.json$/;
const PROJECT = /^projects\/([^/]+)\/project\.json$/;
const DIRECTIONS = /^projects\/([^/]+)\/directions\.json$/;

export function buildTargets(
  files: ReadonlyMap<string, CrossFile>,
  current: number,
  unlistedFolders: readonly string[],
): Targets {
  const underUnlisted = (path: string): boolean =>
    unlistedFolders.some((folder) => path.startsWith(`${folder}/`));
  const references = new Map<string, ReadonlySet<string>>();
  const families = new Set<string>();
  const projects = new Set<string>();
  const directions = new Map<string, ReadonlySet<string>>();
  const guardrails = new Set<string>();

  for (const [path, file] of files) {
    if (file.status !== "valid" || file.formatVersion !== current || underUnlisted(path)) continue;
    let name: string | undefined;
    switch (file.kind) {
      case "reference": {
        name = REFERENCE.exec(path)?.[1];
        const value = file.value as FileValue<"reference">;
        if (name !== undefined) {
          references.set(name, new Set(["p0", ...value.pins.map((pin) => pin.id)]));
        }
        break;
      }
      case "family":
        name = FAMILY.exec(path)?.[1];
        if (name !== undefined) families.add(name);
        break;
      case "project":
        name = PROJECT.exec(path)?.[1];
        if (name !== undefined) projects.add(name);
        break;
      case "directions": {
        name = DIRECTIONS.exec(path)?.[1];
        const value = file.value as FileValue<"directions">;
        if (name !== undefined) {
          directions.set(name, new Set(value.directions.map((entry) => entry.id)));
        }
        break;
      }
      case "guardrails":
        if (path === "guardrails.json") {
          for (const entry of (file.value as FileValue<"guardrails">).guardrails) {
            guardrails.add(entry.id);
          }
        }
        break;
      default:
        break;
    }
  }

  const resolve = (target: LinkTarget): LinkState => {
    const path = targetFileOf(target);
    if (underUnlisted(path)) return "unresolved";
    const file = files.get(path);
    if (file === undefined || file.kind !== KIND_OF_TARGET[target.kind]) return "dangling";
    if (file.status !== "valid" || file.formatVersion !== current) return "unresolved";
    switch (target.kind) {
      case "piece":
        return references.get(target.ref)?.has(target.piece) === true ? "resolved" : "dangling";
      case "family":
      case "project":
        return "resolved";
      case "direction":
        return directions.get(target.project)?.has(target.id) === true ? "resolved" : "dangling";
      case "guardrail":
        return guardrails.has(target.id) ? "resolved" : "dangling";
    }
  };

  return { references, families, projects, directions, guardrails, resolve };
}
