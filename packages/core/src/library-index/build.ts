import type { FileValue } from "../json/canonical.js";
import { type DerivedState, derivedState } from "../model/derived-state.js";
import { effectiveOf, linkWeight } from "../model/effective.js";
import type { CrossFile, LinkEvent } from "../validation/cross.js";
import { type LinkState, type Targets, targetKey } from "./targets.js";
import type { VersionSummary } from "./versions.js";

/**
 * The index of a library (docs/design.md section 4, "Index"): derived data, built from the parsed
 * files only, never from a clock, a fingerprint or the disk. Pure. Every refresh rebuilds it from
 * the same parsed files, so an updated index is always a fresh rebuild.
 *
 * Per-file data (kind, fingerprint, `formatVersion`, status) lives in the snapshot's `files`; the
 * index does not copy it. Only references valid at the current version are indexed until the
 * migration runner (#38) gives older files a value at the current version.
 */

export interface IndexedReference {
  id: string;
  /** `references/<id>.json`. */
  path: string;
  /** `p0`, then the pin ids in file order. */
  pieces: readonly string[];
  /** Format-spec §7.7; a rejected interpretation counts as reviewed (§13.3). */
  state: DerivedState;
  result: { project: string; direction: string | null } | null;
}

/** A piece of a family: a counting member whose target resolves. */
export interface FamilyMember {
  /** A `PieceRef`. */
  target: string;
  /** The description or the link is still to review. */
  tentative: boolean;
}

export interface IndexedFamily {
  slug: string;
  /** `families/<slug>.json`. */
  path: string;
  /** The description is still to review. */
  tentative: boolean;
  /** In file order. */
  members: readonly FamilyMember[];
}

export interface FamilyOfPiece {
  slug: string;
  tentative: boolean;
}

/** One link to a target, wherever it is held. Dangling and unresolved links are listed too. */
export interface Backlink {
  file: string;
  pointer: string;
  holder: string;
  state: LinkState;
}

export interface LibraryIndex {
  versions: VersionSummary;
  /** References valid at the current version, by id, sorted by id. */
  references: ReadonlyMap<string, IndexedReference>;
  /** Families with an effective description, by slug, sorted by slug. */
  families: ReadonlyMap<string, IndexedFamily>;
  /** For each `PieceRef`, the families it is a counting member of, sorted by slug. */
  familiesOf: ReadonlyMap<string, readonly FamilyOfPiece[]>;
  /** The existence sets the dangling checks use, and the rule that resolves a link. */
  targets: Targets;
  /** For each target (`targetKey`), every link to it, in path order then file order. */
  backlinks: ReadonlyMap<string, readonly Backlink[]>;
  /** For each reference id, every link to any of its pieces, including pins that are gone. */
  backlinksToReference: ReadonlyMap<string, readonly Backlink[]>;
}

export interface IndexInput {
  files: ReadonlyMap<string, CrossFile>;
  current: number;
  targets: Targets;
  /** Every link event of the cross-file checks of these files, in the order they were found. */
  links: readonly LinkEvent[];
  versions: VersionSummary;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const REFERENCE = /^references\/([^/]+)\.json$/;
const FAMILY = /^families\/([^/]+)\.json$/;

function sortedMap<V>(map: Map<string, V>): Map<string, V> {
  return new Map([...map].sort(([a], [b]) => compareText(a, b)));
}

export function buildIndex(input: IndexInput): LibraryIndex {
  const { files, current, targets } = input;
  const paths = [...files.keys()].sort(compareText);
  const usable = (file: CrossFile): boolean =>
    file.status === "valid" && file.formatVersion === current;

  const references = new Map<string, IndexedReference>();
  const families = new Map<string, IndexedFamily>();
  for (const path of paths) {
    const file = files.get(path) as CrossFile;
    if (!usable(file)) continue;
    if (file.kind === "reference") {
      const id = REFERENCE.exec(path)?.[1];
      if (id === undefined || !targets.references.has(id)) continue;
      const value = file.value as FileValue<"reference">;
      references.set(id, {
        id,
        path,
        pieces: ["p0", ...value.pins.map((pin) => pin.id)],
        state: derivedState(value),
        result:
          value.result === null
            ? null
            : { project: value.result.project, direction: value.result.direction },
      });
    } else if (file.kind === "family") {
      const slug = FAMILY.exec(path)?.[1];
      if (slug === undefined || !targets.families.has(slug)) continue;
      const value = file.value as FileValue<"family">;
      const description = effectiveOf(value.description);
      // A rejected description: not a family, and its members count for nothing (format-spec §13.3).
      if (description === null) continue;
      const members: FamilyMember[] = [];
      for (const member of value.members) {
        const weight = linkWeight(member);
        if (weight === "none") continue;
        const [ref = "", piece = ""] = member.target.split("#");
        // A dangling or unresolved member counts for nothing (format-spec §14; design section 4).
        if (targets.resolve({ kind: "piece", ref, piece }) !== "resolved") continue;
        members.push({
          target: member.target,
          tentative: description.tentative || weight === "tentative",
        });
      }
      families.set(slug, { slug, path, tentative: description.tentative, members });
    }
  }

  const familiesOf = new Map<string, FamilyOfPiece[]>();
  for (const family of families.values()) {
    for (const member of family.members) {
      let list = familiesOf.get(member.target);
      if (list === undefined) {
        list = [];
        familiesOf.set(member.target, list);
      }
      list.push({ slug: family.slug, tentative: member.tentative });
    }
  }
  for (const list of familiesOf.values()) list.sort((a, b) => compareText(a.slug, b.slug));

  const backlinks = new Map<string, Backlink[]>();
  const backlinksToReference = new Map<string, Backlink[]>();
  const add = (map: Map<string, Backlink[]>, key: string, link: Backlink): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [link]);
    else list.push(link);
  };
  // Stable: links of one file keep the order they were found in.
  const ordered = [...input.links].sort((a, b) => compareText(a.file, b.file));
  for (const event of ordered) {
    const link: Backlink = {
      file: event.file,
      pointer: event.pointer,
      holder: event.holder,
      state: event.state,
    };
    add(backlinks, targetKey(event.to), link);
    if (event.to.kind === "piece") add(backlinksToReference, event.to.ref, link);
  }

  return {
    versions: input.versions,
    references,
    // Paths put `dense-dashboards.json` before `dense.json`; the slugs go the other way.
    families: sortedMap(families),
    familiesOf: sortedMap(familiesOf),
    targets,
    backlinks: sortedMap(backlinks),
    backlinksToReference: sortedMap(backlinksToReference),
  };
}
