import { createHash } from "node:crypto";
import type { Plan } from "../../src/changes/plan.js";
import type { Library } from "../../src/node/open.js";
import type { WriteResult } from "../../src/node/write.js";
import { crossFileIssues, type LinkEvent } from "../../src/validation/cross.js";
import type { Snapshot } from "../../src/validation/library.js";
import { type Json, open } from "./library.js";

/**
 * Helpers for tests of link removal. Test-only: it lives outside `src/`.
 */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const copy = (snapshot: Snapshot, path: string): Json => {
  const file = snapshot.files.get(path);
  if (file === undefined) throw new Error(`no ${path}`);
  return structuredClone(file.value);
};

/**
 * Adds a link to `piece` (a `PieceRef`) in every kind of file that can hold one, through the write
 * pipeline: a member of `dense-dashboards`, a piece of the second glossary term, a source of the
 * second guardrail, evidence of the second statement and a piece of direction `d2`.
 */
export async function linkEverywhere(library: Library, piece: string): Promise<void> {
  const result: WriteResult = await library.write(
    (snapshot): Plan => {
      const family = copy(snapshot, "families/dense-dashboards.json");
      family.members.push({ target: piece, origin: "user", addedAt: "2026-11-04T20:00:00.000Z" });
      const glossary = copy(snapshot, "glossary.json");
      glossary.terms[1].pieces.push(piece);
      const guardrails = copy(snapshot, "guardrails.json");
      guardrails.guardrails[1].sources.push(piece);
      const profile = copy(snapshot, "taste-profile.json");
      profile.statements[1].evidence.push(piece);
      const directions = copy(snapshot, "projects/landing-redesign/directions.json");
      directions.directions[1].pieces.push(piece);
      return {
        changes: [
          { path: "families/dense-dashboards.json", next: family },
          { path: "glossary.json", next: glossary },
          { path: "guardrails.json", next: guardrails },
          { path: "taste-profile.json", next: profile },
          { path: "projects/landing-redesign/directions.json", next: directions },
        ],
        skipped: [],
      };
    },
    { clock: () => new Date("2026-11-04T20:00:00.000Z") },
  );
  if (result.status !== "written") throw new Error(`linkEverywhere: ${JSON.stringify(result)}`);
}

/** Every cross-file link in the library on disk, as the validator sees them. */
export async function linksOnDisk(dir: string): Promise<LinkEvent[]> {
  const snapshot = await (await open(dir)).snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  const links: LinkEvent[] = [];
  const files = new Map(
    [...snapshot.snapshot.files].map(([path, file]) => [
      path,
      {
        kind: file.kind,
        status: file.status,
        formatVersion: file.formatVersion,
        value: file.value,
      },
    ]),
  );
  crossFileIssues(files, {
    current: 1,
    sha256,
    unlistedFolders: snapshot.snapshot.unlistedFolders,
    onLink: (link) => void links.push(link),
  });
  return links;
}

/**
 * Every `Authored` value in the library on disk (an object with `origin` and `content` or
 * `proposal`), as JSON text, so a test can show that link removal edited none of them.
 */
export async function authoredValues(dir: string): Promise<string[]> {
  const snapshot = await (await open(dir)).snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if ("origin" in value && ("content" in value || "proposal" in value)) {
      found.push(JSON.stringify(value));
      return;
    }
    for (const item of Object.values(value)) walk(item);
  };
  for (const file of snapshot.snapshot.files.values()) walk(file.value);
  return found.sort();
}
