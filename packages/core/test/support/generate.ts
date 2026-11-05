import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSeededRandom, type SeededRandom } from "@tastelib/testkit";
import type { LibraryFileKind } from "../../src/format.js";
import {
  newGuardrailId,
  newLibraryId,
  newRefId,
  newStatementId,
  newTermId,
  type RandomSource,
} from "../../src/ids/random.js";
import { canonicalize, type FileValue, serialize } from "../../src/json/canonical.js";
import { mapLimit } from "../../src/node/map-limit.js";

/**
 * The generated library of the performance budget (docs/design.md section 4, "Index",
 * "Performance budget"; section 15, "Core test approach"): synthetic values built as typed v1
 * objects, written through the canonical serializer with 16 writes in flight, and given an mtime
 * in the past so every file is settled, as in a real library. Deterministic per seed.
 * Test-only: it lives outside `src/`.
 */

export interface GenerateOptions {
  references: number;
  families: number;
  membersPerFamily: number;
  terms: number;
  seed: number;
  /** How long ago every file was last modified; one hour by default. */
  ageMs?: number;
}

export interface Generated {
  /** The reference ids, sorted. */
  references: string[];
  /** The family slugs, sorted. */
  families: string[];
  /** The slug of the one project, which has a `directions.json`. */
  project: string;
  /** Every file written, relative to the library. */
  files: string[];
}

const T = "2026-11-01T12:00:00.000Z";
const LATER = "2026-11-02T12:00:00.000Z";
const AGENT = "claude-code";
const WORDS = [
  "calm",
  "dense",
  "quiet",
  "grid",
  "contrast",
  "rhythm",
  "spacing",
  "type",
  "sidebar",
  "table",
  "muted",
  "bold",
  "layered",
  "airy",
  "compact",
  "warm",
  "sharp",
  "soft",
  "editorial",
  "playful",
];

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Interpretation = FileValue<"reference">["interpretations"][string];
type Authored<T> =
  | { origin: "user"; content: T; writtenAt: string }
  | {
      origin: "agent";
      proposedBy: string;
      proposedAt: string;
      inputSha256: null;
      proposal: T;
      status: "to-review" | "accepted" | "corrected" | "rejected";
      correction: T | null;
      reviewedAt: string | null;
    };
type Link = FileValue<"family">["members"][number];

class Draw {
  readonly random: SeededRandom;
  constructor(random: SeededRandom) {
    this.random = random;
  }
  int(min: number, max: number): number {
    return min + this.random.int(max - min + 1);
  }
  chance(p: number): boolean {
    return this.random.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.random.int(items.length)] as T;
  }
  words(count: number): string {
    return Array.from({ length: count }, () => this.pick(WORDS)).join(" ");
  }
  sentence(count: number): string {
    const text = this.words(count);
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  tags(max: number): string[] {
    return [...new Set(Array.from({ length: this.int(0, max) }, () => this.pick(WORDS)))];
  }
  hex(length: number): string {
    return Array.from({ length }, () => "0123456789abcdef"[this.random.int(16)]).join("");
  }
  source(): RandomSource {
    return (bytes) => {
      for (let index = 0; index < bytes.length; index++) bytes[index] = this.random.int(256);
    };
  }
  /** Thousandths, so regions are canonical as written. */
  thousandths(min: number, max: number): number {
    return this.int(Math.round(min * 1000), Math.round(max * 1000)) / 1000;
  }
}

/** An `Authored` value of every origin and status, so the derived states and staleness vary. */
function authored<T>(draw: Draw, content: T, corrected: T): Authored<T> {
  const roll = draw.int(0, 4);
  if (roll === 0) return { origin: "user", content, writtenAt: T };
  const status = (["to-review", "accepted", "corrected", "rejected"] as const)[roll - 1] as
    | "to-review"
    | "accepted"
    | "corrected"
    | "rejected";
  return {
    origin: "agent",
    proposedBy: AGENT,
    proposedAt: T,
    inputSha256: null,
    proposal: content,
    status,
    correction: status === "corrected" ? corrected : null,
    reviewedAt: status === "to-review" ? null : LATER,
  };
}

function interpretation(draw: Draw, note: string): Interpretation {
  const content = () => ({
    summary: draw.sentence(draw.int(6, 14)),
    vocabulary: draw.tags(3),
    keywords: draw.tags(4),
    screenTypes: draw.tags(2),
    components: draw.tags(3),
    aspects: draw.tags(2),
  });
  const value = authored(draw, content(), content());
  // Nothing is stale: a proposal records the SHA-256 of the note it was made over.
  return value.origin === "user" ? value : { ...value, inputSha256: sha256(note) };
}

function link(draw: Draw, target: string): Link {
  const roll = draw.int(0, 3);
  if (roll === 0) return { target, origin: "user", addedAt: T };
  const status = (["to-review", "accepted", "rejected"] as const)[roll - 1] as
    | "to-review"
    | "accepted"
    | "rejected";
  return {
    target,
    origin: "agent",
    proposedBy: AGENT,
    proposedAt: T,
    status,
    reviewedAt: status === "to-review" ? null : LATER,
  };
}

function reference(draw: Draw, id: string): FileValue<"reference"> {
  const media = Array.from({ length: draw.int(1, 2) }, (_, index) => ({
    id: `m${index + 1}`,
    kind: "image" as const,
    file: `${id}/m${index + 1}.png`,
    type: "image/png" as const,
    bytes: draw.int(2_000, 400_000),
    sha256: draw.hex(64),
    width: draw.int(320, 2560),
    height: draw.int(240, 4000),
    durationMs: null,
    frames: [],
  }));
  const pins = Array.from({ length: draw.int(0, 5) }, (_, index) => {
    const x = draw.thousandths(0, 0.5);
    const y = draw.thousandths(0, 0.5);
    return {
      id: `p${index + 1}`,
      mediaId: draw.pick(media).id,
      frameMs: null,
      region: { x, y, w: draw.thousandths(0.05, 0.5), h: draw.thousandths(0.05, 0.5) },
      polarity: draw.chance(0.7) ? ("positive" as const) : ("negative" as const),
      note: draw.sentence(draw.int(4, 16)),
      createdAt: T,
    };
  });
  const note = draw.sentence(draw.int(20, 70));
  const interpretations: Record<string, Interpretation> = {};
  for (const [piece, pieceNote] of [
    ["p0", note],
    ...pins.map((pin) => [pin.id, pin.note] as const),
  ] as const) {
    if (draw.chance(0.6)) interpretations[piece] = interpretation(draw, pieceNote);
  }
  return {
    formatVersion: 1,
    id,
    createdAt: T,
    updatedAt: T,
    source: { via: "paste", url: null },
    result: null,
    media,
    note,
    pins,
    interpretations,
    lastIssued: { media: media.length, pin: pins.length },
  };
}

/**
 * Writes the library into `root` (which must exist and be empty) and returns what it holds.
 * Shape (docs/design.md section 4, "Performance budget"): 1–2 `image/png` media and 0–5 pins per
 * reference, about 60% of pieces interpreted with every origin and status, families of unique
 * members, glossary terms, guardrails, taste-profile statements and one project with directions.
 */
export async function generateLibrary(root: string, options: GenerateOptions): Promise<Generated> {
  const draw = new Draw(createSeededRandom(options.seed));
  const random = draw.source();
  const out = new Map<string, { kind: LibraryFileKind; value: unknown }>();
  const put = <K extends LibraryFileKind>(path: string, kind: K, value: FileValue<K>) => {
    out.set(path, { kind, value });
  };

  put("library.json", "library", {
    formatVersion: 1,
    id: newLibraryId({ random }),
    name: "Generated library",
    language: "en",
    createdAt: T,
  });

  const taken = new Set<string>();
  const ids: string[] = [];
  const pieces: string[] = [];
  for (let index = 0; index < options.references; index++) {
    const day = new Date(Date.UTC(2026, 0, 1 + draw.int(0, 300)));
    const id = newRefId({ random, now: () => day, exists: (candidate) => taken.has(candidate) });
    taken.add(id);
    ids.push(id);
    const value = reference(draw, id);
    pieces.push(`${id}#p0`, ...value.pins.map((pin) => `${id}#${pin.id}`));
    put(`references/${id}.json`, "reference", value);
  }
  ids.sort();
  const somePieces = (max: number): string[] => [
    ...new Set(Array.from({ length: draw.int(0, max) }, () => draw.pick(pieces))),
  ];

  const slugs: string[] = [];
  for (let index = 0; index < options.families; index++) {
    const slug = `family-${index + 1}`;
    slugs.push(slug);
    const members = new Set<string>();
    const wanted = Math.min(options.membersPerFamily, pieces.length);
    while (members.size < wanted) members.add(draw.pick(pieces));
    const description = () => ({
      name: `Family ${index + 1}`,
      meaning: draw.sentence(draw.int(8, 20)),
      vocabulary: draw.tags(3),
    });
    put(`families/${slug}.json`, "family", {
      formatVersion: 1,
      slug,
      createdAt: T,
      updatedAt: T,
      description: authored(draw, description(), description()),
      members: [...members].map((target) => link(draw, target)),
    });
  }

  const terms = Array.from({ length: options.terms }, (_, index) => {
    const content = () => ({ term: `Term ${index + 1}`, definition: draw.sentence(10) });
    return {
      id: newTermId({ random }),
      createdAt: T,
      updatedAt: T,
      pieces: somePieces(3),
      entry: authored(draw, content(), content()),
    };
  });
  put("glossary.json", "glossary", { formatVersion: 1, terms });

  const guardrails = Array.from({ length: 20 }, () => ({
    id: newGuardrailId({ random }),
    createdAt: T,
    updatedAt: T,
    sources: somePieces(2),
    rule: authored(draw, { text: draw.sentence(8) }, { text: draw.sentence(8) }),
  }));
  put("guardrails.json", "guardrails", { formatVersion: 1, guardrails });

  const statements = Array.from({ length: 20 }, () => {
    const content = () => ({
      kind: draw.chance(0.5) ? ("like" as const) : ("rejection" as const),
      text: draw.sentence(10),
    });
    return {
      id: newStatementId({ random }),
      createdAt: T,
      updatedAt: T,
      evidence: somePieces(3),
      statement: authored(draw, content(), content()),
    };
  });
  put("taste-profile.json", "taste-profile", { formatVersion: 1, statements });

  const project = "generated-project";
  put(`projects/${project}/project.json`, "project", {
    formatVersion: 1,
    slug: project,
    createdAt: T,
    updatedAt: T,
    name: "Generated project",
    intent: null,
    discarded: [],
  });
  const directions = Array.from({ length: 5 }, (_, index) => ({
    id: `d${index + 1}`,
    createdAt: T,
    updatedAt: T,
    family: slugs.length > 0 && draw.chance(0.8) ? draw.pick(slugs) : null,
    pieces: somePieces(4),
    guardrails: [
      ...new Set(Array.from({ length: draw.int(0, 2) }, () => draw.pick(guardrails).id)),
    ],
    plan: authored(
      draw,
      { title: `Direction ${index + 1}`, why: draw.sentence(8) },
      { title: `Direction ${index + 1}`, why: draw.sentence(8) },
    ),
  }));
  put(`projects/${project}/directions.json`, "directions", {
    formatVersion: 1,
    directions,
    lastIssued: { direction: directions.length },
  });

  for (const folder of ["references", "families", "projects", `projects/${project}`]) {
    await mkdir(join(root, ...folder.split("/")), { recursive: true });
  }
  const seconds = (Date.now() - (options.ageMs ?? 3_600_000)) / 1000;
  await mapLimit([...out], 16, async ([path, { kind, value }]) => {
    const target = join(root, ...path.split("/"));
    await writeFile(target, serialize(kind, canonicalize(kind, value)));
    await utimes(target, seconds, seconds);
  });
  return { references: ids, families: slugs, project, files: [...out.keys()].sort() };
}
