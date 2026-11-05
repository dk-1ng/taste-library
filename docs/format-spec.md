# Library format specification

**Status: v1, frozen on 2026-11-04.** `formatVersion` is `1`. Any change to what this document describes is a new format version with a migration (§15; one exception, recorded in §15.1); this document is then updated to describe the new version, and the change is recorded in [design.md](design.md) §18.

This is the public contract for a taste-library library on disk. The tool, agents and third-party integrations follow it. Behavior that is not about the data format lives in [design.md](design.md). The executable form of this specification is the zod schemas in `packages/core`; where they disagree, this document is right and the code has a bug.

## 1. Principles

- Plain, human-readable JSON files. One reference per file.
- Every JSON file carries `formatVersion`. Older versions are migrated automatically, and every migration is tested (§15).
- The user's words are stored verbatim. Agent interpretation is a separate block with a review status (§13).
- Media is not part of the library folder. It lives in a separate media folder and is referenced by relative path, size and checksum (§6).
- No file in the library holds a machine path, an account or anything specific to one computer. Where things are on a computer is per-machine configuration ([design.md](design.md) §4).
- Agents read files directly and write only through `tastelib` (CLI or MCP), which validates every write against this specification.

## 2. Notation

Schemas are written in a TypeScript-like notation. `T | null` means the field is present and may be `null`; there are no optional fields: every field listed is always present, and no other field is allowed (§3.4). Fields are listed in their canonical order (§3.3). Shared types are defined in §4. A comment `// n–m` on an array gives its minimum and maximum number of items.

## 3. Files

### 3.1 Encoding and line endings

- Every file is UTF-8. Writers never write a byte order mark (BOM); readers accept one and report `not-canonical` (§16).
- Writers use LF line endings and end every file with exactly one LF. Readers accept CRLF and report `not-canonical`.
- Text must be well-formed Unicode: a JSON `\u` escape that produces a lone surrogate is an error (`invalid-encoding`).
- Text is never Unicode-normalized when stored. Comparisons that must ignore form and case (uniqueness of tags and glossary terms) compare the NFC form lowercased with the locale-independent `toLowerCase()`.

### 3.2 JSON

- Plain JSON (RFC 8259): no comments, no trailing commas.
- An object with the same key twice is an error (`duplicate-key`), even though many JSON parsers silently keep the last value: it usually means a Git merge was resolved by hand and data may have been lost.
- A JSON file larger than 8 MiB is not parsed and is reported as `file-too-large`.
- Integers are non-negative and at most 2^53 − 1. Proportions (§7.3) are finite numbers.

### 3.3 Canonical form

Writers produce the canonical form, so that the same data gives the same bytes and Git diffs stay small:

- Two-space indentation, as produced by `JSON.stringify(value, null, 2)`, plus a final LF. Non-ASCII characters are written as themselves, not as `\u` escapes.
- Object keys in the order this document lists them. Map keys (§7.6) in the order defined for that map.
- Arrays of objects with an `id` or `slug` are sorted as stated for each array; other arrays keep the order in which they were written.
- Proportions are rounded to at most 6 decimal places.

A file that parses and validates but is not in canonical form is valid; `validate` reports `not-canonical` (a warning), and the next write through `tastelib` rewrites it canonically. Not canonical: a BOM, CRLF line endings, other whitespace or indentation, keys or list entries out of order, `\u` escapes for characters that need none, and proportions with more than 6 decimal places.

### 3.4 Strictness

- An unknown field is an error (`schema-violation`). There is no extension field: data this specification does not describe has no place in a library.
- A missing field is an error, including fields whose value would be `null` or an empty array.

## 4. Shared types

### 4.1 Timestamps

```ts
type Timestamp = string; // UTC, millisecond precision: "2026-11-04T12:00:00.000Z"
```

- Pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, and the value must round-trip: `new Date(s).toISOString() === s` (this rejects dates such as February 30).
- Always UTC with `Z`; no offsets. The interface shows times in the user's local time zone.
- `createdAt` is set once when the thing is created. `updatedAt` is set on every write that changes the file's content, and is never earlier than `createdAt`.
- **Clock skew.** Files move between computers whose clocks may disagree. A timestamp with a lower bound (`updatedAt` ≥ `createdAt`, `reviewedAt` ≥ `proposedAt`) is set by the writer to the later of the current time and that bound, so a write never fails or produces an invalid file because another computer's clock was ahead.

### 4.2 Text

Lengths are counted in Unicode code points, not UTF-16 code units. "Control characters" are U+0000–U+001F and U+007F–U+009F.

```ts
type Line<Max> = string; // 1–Max code points, single line: no control characters at all
type Tag = string;       // 1–64 code points, single line, no leading or trailing whitespace
type Text<Min, Max> = string; // Min–Max code points; line breaks are "\n"; "\t" allowed; no other control characters
type Name = Line<200>;
type TagList = Tag[];    // 0–50, unique (compared as in §3.1)
type Note = Text<0, 100000>;
```

- **User's words** (notes, pin notes, names, corrections, user-authored content) are stored exactly as the user entered them. The only change the app makes is storing line breaks as `\n` (a pasted `\r\n` or `\r` becomes `\n`). It never trims, normalizes, reflows or corrects them. A value that breaks a rule is refused, never altered.
- **Agent text** follows the same types.

### 4.3 Identifiers

Random parts use the lowercase Crockford base32 alphabet `0123456789abcdefghjkmnpqrstvwxyz` (no `i`, `l`, `o`, `u`), drawn from a cryptographic random source. A generated identifier that already exists in the library is drawn again.

| Type | Pattern | Example | Scope |
| --- | --- | --- | --- |
| `LibraryId` | `^lib-[0-9a-hjkmnp-tv-z]{10}$` | `lib-7d2k9q4m1x` | the library |
| `RefId` | `^ref-\d{8}-[0-9a-hjkmnp-tv-z]{6}$` | `ref-20261104-k3x9ab` | the library |
| `GuardrailId` | `^gr-[0-9a-hjkmnp-tv-z]{6}$` | `gr-4m8q2z` | `guardrails.json` |
| `TermId` | `^term-[0-9a-hjkmnp-tv-z]{6}$` | `term-9x2b7c` | `glossary.json` |
| `StatementId` | `^st-[0-9a-hjkmnp-tv-z]{6}$` | `st-1h6v3r` | `taste-profile.json` |
| `MediaId` | `^m[1-9]\d*$` | `m1` | one reference |
| `PinId` | `^p[1-9]\d*$` | `p3` | one reference |
| `LocalPieceId` | `^p(0\|[1-9]\d*)$` | `p0` | one reference |
| `DirectionId` | `^d[1-9]\d*$` | `d2` | one project |
| `Slug` | see below | `quiet-editorial` | families; projects |
| `PieceRef` | `<RefId>#<LocalPieceId>` | `ref-20261104-k3x9ab#p2` | the library |
| `AgentLabel` | `^[a-z0-9][a-z0-9._-]{0,63}$` | `claude-code` | label of the writing agent |

- The 8 digits of a `RefId` are the UTC date of creation (`YYYYMMDD`), and must be a valid calendar date. They are informational and are not compared with `createdAt`.
- The number in a sequential identifier (`m`, `p`, `d`) is an integer of at most 2^53 − 1 (§3.2); a larger number is refused.
- Sequential identifiers (`m`, `p`, `d`) are **never reused**. The file that holds them records the highest number ever issued (`lastIssued`, §7.1 and §12.2); a new item takes that number plus one, and the counter never goes down, even when the item with the highest number is deleted. A deletion still removes every link to the deleted thing (§14).
- `p0` is the whole-reference note: a piece that covers every media item of the reference, in id order (for a reference with one media item, that item; for a capture split into segments, every segment). `p1`, `p2`… are pins.
- **Slugs:** `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 characters, and not one of the Windows reserved device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). **A slug never changes**: renaming changes `name` (or the family's name), not the slug. A slug is derived from the name when the thing is created, in this order:
  1. **Derive:** decompose with NFKD, drop combining marks, lowercase, replace each run of characters other than `a–z` and `0–9` with `-`, trim `-`.
  2. **Shorten** to at most 64 characters, always: cut at the last `-` within the limit, or exactly at the limit when there is no `-` within it, then remove a trailing `-`.
  3. **Empty or reserved** (shortening can produce one, for example `con`): the slug becomes `family-<6 random>` or `project-<6 random>`.
  4. **Taken:** append `-2`, `-3`…, the first that is free. Before appending, shorten the base with the cut rule of step 2 so that base and suffix together are at most 64 characters.
- File and folder names in the format come only from these identifiers, so they are ASCII, lowercase and safe on every file system, including case-insensitive ones. No name is derived from user text at run time except through the slug rule above.

### 4.4 Checksums

```ts
type Sha256 = string; // ^[0-9a-f]{64}$: SHA-256 of the exact bytes, lowercase hex
```

### 4.5 URLs

```ts
type HttpUrl = string;
```

An absolute `http:` or `https:` URL, at most 2048 characters, stored as the WHATWG URL parser's `href` for it. A URL with a user name or password is refused.

### 4.6 Authored values

Every value that an agent may propose is stored as an `Authored<T>`, which records who wrote it and, for agent proposals, its review status. The rules are in §13.

```ts
type Authored<T> =
  | {
      origin: "user";
      content: T;              // the user's words, verbatim
      writtenAt: Timestamp;    // last time the user wrote it
    }
  | {
      origin: "agent";
      proposedBy: AgentLabel;
      proposedAt: Timestamp;
      inputSha256: Sha256 | null; // fingerprint of the user's words the proposal is based on (§13.4)
      proposal: T;             // the agent's words
      status: "to-review" | "accepted" | "corrected" | "rejected";
      correction: T | null;    // the user's version, verbatim
      reviewedAt: Timestamp | null;
    };
```

Invariants of the agent form: `correction` is not `null` if and only if `status` is `"corrected"`; `reviewedAt` is `null` if and only if `status` is `"to-review"`; `reviewedAt` is not earlier than `proposedAt`; `inputSha256` is not `null` in a piece interpretation (§7.6) and is `null` everywhere else.

Links between things (pieces in a family, sources of a guardrail and so on) are never inside an `Authored` value. They sit next to it, so that deleting a piece can remove links without editing anyone's words.

### 4.7 Reviewed links

A link that an agent may propose (a piece in a family) is a `ReviewedLink`:

```ts
type ReviewedLink<K> =
  | { target: K; origin: "user"; addedAt: Timestamp }
  | {
      target: K;
      origin: "agent";
      proposedBy: AgentLabel;
      proposedAt: Timestamp;
      status: "to-review" | "accepted" | "rejected";
      reviewedAt: Timestamp | null; // null if and only if status is "to-review"; not earlier than proposedAt
    };
```

## 5. Library folder

```
<library>/
  library.json                   # required: marks the folder as a library
  references/<ref-id>.json       # one reference per file
  families/<slug>.json           # one family per file
  glossary.json                  # optional; absent means empty
  guardrails.json                # optional; absent means empty
  taste-profile.json             # optional; absent means empty
  projects/<slug>/project.json   # one project per folder
  projects/<slug>/directions.json  # optional; absent means no directions
  .tastelib/                     # tool working area (index, cache, migration backup); never committed
  .gitignore                     # written by `tastelib init`; contains `.tastelib/`
```

- A folder is a library if and only if it contains `library.json`. The folders are created when first needed.
- The file name must match the identifier inside: `references/<id>.json`, `families/<slug>.json`, `projects/<slug>/` (otherwise `name-mismatch`).
- `.tastelib/` is not part of the format: tools may put anything there and delete it at any time, and `validate` ignores it. **Exception:** `.tastelib/migration-backup/` is created and removed only by `tastelib` (§15.3). While a migration is interrupted it holds the only copy of the files as they were before, so deleting it then can lose data. Cleaning tools delete it too (for example `git clean -X`, which removes ignored files), so do not run them on a library while `tastelib` reports a migration in progress or interrupted.
- Other files at the top level (for example `README.md`, `.git/`, `.gitattributes`) are ignored. Any other file inside `references/`, `families/` or `projects/` is reported as `unexpected-file`, except leftover temporary files from an interrupted write (`.<name>.tmp-<random>`), reported as `leftover-temp-file`.
- Writers replace a file atomically: they write a temporary file in the same folder, then rename it over the target. Files that recovery depends on (the migration backup's copies, `owner.json` and `manifest.json`, and the library files written by a migration or restored from its backup, §15.3) are also made durable: the file is flushed to disk (`fsync`) before the rename, and the folder after it (and after a deletion) where the operating system supports it (not on Windows).
- **Concurrent writers.** The app and an agent may write at the same time. A writer remembers the exact bytes of the file as it read them (or that the file did not exist). Just before the rename, it reads the target again; if the bytes differ (or a file now exists where there was none), it deletes its temporary file and refuses the write with `write-conflict` (§16.2), and the caller reads again and retries. This is an optimistic check, not a lock: it narrows the window to the moment between the check and the rename, which is enough for one person's app and agents on one computer.
- **Writes that touch several files** (a deletion that removes links, a family merge) are not atomic as a whole. To keep a partial stop harmless, `tastelib`:
  1. checks every target file (the optimistic check above) before the first rename, and refuses the whole write if any has changed;
  2. writes the primary change first (the file that holds the user's decision: the deleted pin's reference, the family that receives the merged pieces) and removes links from other files after it;
  3. if it still stops partway (a conflict in the short window, a crash), reports which files were written and which were not.

  A partial stop therefore leaves at worst `dangling-link` warnings (§14), never a lost decision.
- The longest relative path the format produces is under 100 characters, so libraries stay within the classic Windows path limit unless the library folder itself is deep.

### 5.1 `library.json`

```ts
type Library = {
  formatVersion: 1;
  id: LibraryId;
  name: Name;              // the user's words
  language: LanguageTag;   // language in which agents write proposals
  createdAt: Timestamp;
};
```

- `LanguageTag` is a BCP 47 tag limited to `^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$` (for example `en`, `pt-BR`). It tells agents which language to write proposals in. It is not the interface language, which is a per-machine setting ([design.md](design.md) §12).
- The `formatVersion` of `library.json` is the library's format version (§15).

```json
{
  "formatVersion": 1,
  "id": "lib-7d2k9q4m1x",
  "name": "Interfaces I keep coming back to",
  "language": "en",
  "createdAt": "2026-11-04T12:00:00.000Z"
}
```

## 6. Media folder

```
<media>/
  tastelib-media.json            # marker: which library this media folder belongs to
  <ref-id>/m<n>.<ext>            # a media item of the reference
  <ref-id>/m<n>-t<ms>.<ext>      # a frame of video m<n>, taken at <ms> milliseconds
```

### 6.1 Marker

```ts
type MediaMarker = {
  formatVersion: 1;
  libraryId: LibraryId;
};
```

`tastelib` writes the marker when it first attaches a media folder to a library. A marker with another library's id is an error (`media-folder-mismatch`): the wrong folder is attached. A missing marker is a warning (`media-marker-missing`).

### 6.2 Media paths

```ts
type MediaPath = string;
// ^<RefId>/m[1-9]\d*(-t(0|[1-9]\d*))?\.(webp|png|jpg|avif|mp4|webm)$
```

- Relative to the media folder, with `/` as the separator on every operating system. Tools split it on `/` and join the parts with the platform's path functions; they never pass it whole to a function that interprets `..` or drive letters (the pattern rules them out anyway).
- The first segment is the id of the reference that owns the file, and the media id (and frame time) in the name match the entry that lists it.
- The extension matches the media type: `webp` = `image/webp`, `png` = `image/png`, `jpg` = `image/jpeg`, `avif` = `image/avif`, `mp4` = `video/mp4`, `webm` = `video/webm`.
- After resolving symbolic links, a media file must stay inside the media folder (otherwise `media-outside-folder`).

### 6.3 Size and checksum

Each media file is described by `bytes` (its exact size) and `sha256` (§4.4) of the file as stored, after compression, not of what the user pasted.

| Situation | Report (§16) |
| --- | --- |
| The media folder is not configured on this machine | `media-not-checked` (info), once |
| The file is missing | `awaiting-sync` (info): it may still be syncing ([design.md](design.md) §4) |
| Size or checksum differs | `media-mismatch` (warning): the file may be half-synced or damaged; it is never rewritten automatically |
| The media folder is configured but cannot be read (absent, not a folder, no permission) | `unreadable-file` (error), `file: null`, once; no media file is checked |
| A media file exists but cannot be read, or the path is not a regular file | `unreadable-file` (error) at `media:<path>`; a path that is not a regular file is `media-mismatch` (warning) |
| A file in a reference folder of the media folder is named like a media file (`m<n>[-t<ms>].<ext>`, §6.2) and no reference lists it | `orphan-media` (warning). Other names (`.DS_Store`, `desktop.ini`, `Thumbs.db`, `.directory`, …) are ignored. Nothing is an orphan when `references/` or the owner reference cannot be read: what is listed is then unknown |

The marker is read before the files. A marker that is unreadable, invalid or from a newer version is reported (§16.2), and the files are still checked; only `media-folder-mismatch` skips the file checks.

`validate` compares sizes by default and checksums with `--checksums` (§16).

## 7. Reference: `references/<ref-id>.json`

### 7.1 Schema

```ts
type Reference = {
  formatVersion: 1;
  id: RefId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  source: {
    via: "paste" | "drop" | "file-picker" | "url-capture"; // file-picker = a file chosen with the app's file chooser
    url: HttpUrl | null;   // required (not null) when via is "url-capture"
  };
  result: {                // not null when this is a generated version brought back to a project
    project: Slug;
    direction: DirectionId | null;
  } | null;
  media: Media[];          // 1–50, sorted by id number, ids unique
  note: Note;              // the user's whole-reference note (piece p0); may be ""
  pins: Pin[];             // 0–500, sorted by id number, ids unique
  interpretations: { [piece: LocalPieceId]: Authored<PieceInterpretation> };
  lastIssued: {            // highest numbers ever issued in this reference (§4.3)
    media: number;         // integer ≥ the highest media id number in use; ≥ 1
    pin: number;           // integer ≥ the highest pin id number in use; 0 when no pin was ever made
  };
};
```

### 7.2 Media

```ts
type Media = {
  id: MediaId;
  kind: "image" | "page" | "video"; // page = full-page capture of a URL
  file: MediaPath;
  type: "image/webp" | "image/png" | "image/jpeg" | "image/avif" | "video/mp4" | "video/webm";
  bytes: number;           // integer ≥ 1
  sha256: Sha256;
  width: number;           // integer, 1–1000000, pixels
  height: number;          // integer, 1–1000000, pixels
  durationMs: number | null; // integer ≥ 1 for a video; null otherwise
  frames: Frame[];         // video only (empty otherwise); 0–1000, sorted by timeMs, timeMs unique
};

type Frame = {
  timeMs: number;          // integer, 0 ≤ timeMs ≤ durationMs
  file: MediaPath;         // <ref-id>/m<n>-t<timeMs>.<ext>
  type: "image/webp" | "image/png" | "image/jpeg" | "image/avif";
  bytes: number;           // integer ≥ 1
  sha256: Sha256;
  width: number;           // integer, 1–1000000, pixels
  height: number;          // integer, 1–1000000, pixels
};
```

- `kind` `image` and `page` take an `image/*` type; `video` takes a `video/*` type. Animated GIFs are stored as videos.
- A media item's file is `<ref-id>/<media-id>.<ext>`.

### 7.3 Pins

```ts
type Pin = {
  id: PinId;
  mediaId: MediaId;        // a media item of this reference
  frameMs: number | null;  // for a video: the timeMs of one of its frames; null otherwise
  region: { x: number; y: number; w: number; h: number };
  polarity: "positive" | "negative"; // take this / not this
  note: Note;              // the user's words; may be ""
  createdAt: Timestamp;
};
```

- `region` is in proportions of the media's (or frame's) width and height: `0 ≤ x`, `0 ≤ y`, `0 < w`, `0 < h`, `x + w ≤ 1`, `y + h ≤ 1` (compared with a tolerance of 1e-9).

### 7.4 Pieces

A piece is something the user pointed at: the whole-reference note (`p0`, covering every media item of the reference, in id order) or a pin. Pieces are addressed across the library as `PieceRef` (`ref-20261104-k3x9ab#p2`). `p0` always exists.

### 7.5 Piece interpretation

```ts
type PieceInterpretation = {
  summary: Text<1, 2000>;
  vocabulary: TagList;     // aesthetic vocabulary
  keywords: TagList;
  screenTypes: TagList;    // screen or page types, for example "pricing page"
  components: TagList;     // for example "data table"
  aspects: TagList;        // design aspects, for example "typography"
};
```

Guardrails are not part of an interpretation: an agent that reads a negative pin as a rule proposes a guardrail in `guardrails.json` with the pin as its source (§10).

### 7.6 Interpretations map

- Keys are `p0` or the id of a pin of this reference (otherwise `broken-local-link`). At most one interpretation per piece.
- Canonical key order: by piece number (`p0`, `p1`, `p2`, `p10`).
- For an agent proposal, `inputSha256` is the SHA-256 of the piece's note (UTF-8 bytes) at the time of the proposal, computed by `tastelib` (§13.4).

### 7.7 Derived state

The reference's state is not stored; it is derived:

| State | Rule |
| --- | --- |
| inbox | no piece has an interpretation |
| reviewed | every piece has an interpretation and none is `to-review` |
| processed | any other case: some pieces are interpreted, or some interpretations are `to-review` |

### 7.8 Example

```json
{
  "formatVersion": 1,
  "id": "ref-20261104-k3x9ab",
  "createdAt": "2026-11-04T12:00:00.000Z",
  "updatedAt": "2026-11-04T12:05:00.000Z",
  "source": {
    "via": "url-capture",
    "url": "https://example.com/"
  },
  "result": null,
  "media": [
    {
      "id": "m1",
      "kind": "page",
      "file": "ref-20261104-k3x9ab/m1.webp",
      "type": "image/webp",
      "bytes": 48213,
      "sha256": "4309daa14fddb96930dc5888171cb48fdd6f9f1998b258b31b4743f269de307d",
      "width": 1440,
      "height": 5200,
      "durationMs": null,
      "frames": []
    }
  ],
  "note": "Calm and dense at the same time.",
  "pins": [
    {
      "id": "p1",
      "mediaId": "m1",
      "frameMs": null,
      "region": {
        "x": 0.08,
        "y": 0.12,
        "w": 0.4,
        "h": 0.3
      },
      "polarity": "negative",
      "note": "This hero is too loud.",
      "createdAt": "2026-11-04T12:01:00.000Z"
    }
  ],
  "interpretations": {
    "p0": {
      "origin": "agent",
      "proposedBy": "claude-code",
      "proposedAt": "2026-11-04T12:05:00.000Z",
      "inputSha256": "761b7a17a8e0eab9e2912cd96565d633e2c7dfaf291e3e9627dfebf91e3c5885",
      "proposal": {
        "summary": "High information density with quiet contrast.",
        "vocabulary": [
          "quiet density"
        ],
        "keywords": [
          "calm",
          "dense"
        ],
        "screenTypes": [
          "landing page"
        ],
        "components": [],
        "aspects": [
          "layout"
        ]
      },
      "status": "to-review",
      "correction": null,
      "reviewedAt": null
    }
  },
  "lastIssued": {
    "media": 1,
    "pin": 1
  }
}
```

`inputSha256` above is the SHA-256 of the note `Calm and dense at the same time.`; the media checksum is a placeholder.

## 8. Family: `families/<slug>.json`

```ts
type Family = {
  formatVersion: 1;
  slug: Slug;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  description: Authored<{
    name: Name;
    meaning: Text<1, 4000>;
    vocabulary: TagList;
  }>;
  members: ReviewedLink<PieceRef>[]; // 0–10000, sorted by target (reference id, then piece number), targets unique
};
```

- Membership lives only in the family file; a reference does not list its families.
- A rejected member stays in the list, so that agents do not propose it again.
- Merging family A into family B moves A's members into B (keeping their review state), deletes A, and replaces links to A (§14).

## 9. Glossary: `glossary.json`

```ts
type Glossary = {
  formatVersion: 1;
  terms: Term[];           // 0–10000, sorted by id
};

type Term = {
  id: TermId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  pieces: PieceRef[];      // 0–100, examples; unique
  entry: Authored<{
    term: Tag;
    definition: Text<1, 4000>;
  }>;
};
```

Two terms whose effective `term` (§13.3) compares equal (§3.1) are reported as `duplicate-term` (a warning).

## 10. Guardrails: `guardrails.json`

```ts
type Guardrails = {
  formatVersion: 1;
  guardrails: Guardrail[]; // 0–10000, sorted by id
};

type Guardrail = {
  id: GuardrailId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  sources: PieceRef[];     // 0–100, the pieces (usually negative pins) it comes from; unique
  rule: Authored<{ text: Text<1, 500> }>;
};
```

A guardrail is a **candidate** while its rule is an agent proposal `to-review`, and **approved** when its effective value exists and is not tentative (§13.3): user-authored, accepted or corrected.

## 11. Taste profile: `taste-profile.json`

```ts
type TasteProfile = {
  formatVersion: 1;
  statements: Statement[]; // 0–2000, sorted by id
};

type Statement = {
  id: StatementId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  evidence: PieceRef[];    // 0–100; unique
  statement: Authored<{
    kind: "like" | "rejection" | "contradiction";
    text: Text<1, 2000>;
  }>;
};
```

The taste profile is stored as structured statements, each with its own review status. A Markdown view of it is rendered on demand (for example in an export); it is not stored in the library.

## 12. Projects: `projects/<slug>/`

### 12.1 `project.json`

```ts
type Project = {
  formatVersion: 1;
  slug: Slug;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  name: Name;              // the user's words
  intent: Authored<Intent> | null; // null until drafted or written
  discarded: Discarded[];  // 0–500, in the order the agent listed them
};

type Intent = {
  what: Text<1, 4000>;     // what is being built
  forWhom: Text<1, 4000>;  // for whom
  userTasks: Line<500>[];  // 0–20, what users must do
  why: Text<1, 4000>;      // why
};

type Discarded = {
  text: Text<1, 500>;      // what the briefing said
  category: "style" | "color" | "font" | "named-direction" | "other-visual";
};
```

- The briefing itself is not stored in the library. Only the intent drawn from it and the list of what was discarded are kept ([design.md](design.md) §9).
- `discarded` is written by `tastelib` together with an agent intent proposal, and replaced whenever a new intent proposal is stored. It is a record shown to the user, never part of the intent: agents must not use it as input for directions, packs or prompts.
- Where packs are exported is a per-machine setting, not part of the project.

### 12.2 `directions.json`

```ts
type Directions = {
  formatVersion: 1;
  directions: Direction[]; // 0–50, sorted by id number
  lastIssued: {            // highest number ever issued in this project (§4.3)
    direction: number;     // integer ≥ the highest direction id number in use
  };
};

type Direction = {
  id: DirectionId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  family: Slug | null;
  pieces: PieceRef[];      // 0–100, in the order chosen; unique
  guardrails: GuardrailId[]; // 0–100; unique
  plan: Authored<{
    title: Name;
    why: Text<1, 4000>;    // why it fits the intent
  }>;
};
```

### 12.3 Results

A generated version brought back to a project is an ordinary reference (§7) whose `result` names the project and, when known, the direction. It is captured, pinned, interpreted and reviewed like any other reference. There is no separate results folder.

## 13. Interpretation layer

### 13.1 Who writes what

Agent rights are an **allowlist**. Through `tastelib` (CLI or MCP), an agent may only:

1. **Propose a piece interpretation:** add an `Authored` value with `origin: "agent"` and `status: "to-review"` for a piece that has none.
2. **Create an entry** (a family, a glossary term, a guardrail, a taste-profile statement or a direction) whose `Authored` value is an agent proposal `to-review`, and set the entry's plain links (`pieces`, `sources`, `evidence`, a direction's `family`, `pieces` and `guardrails`) when it is created. `tastelib` sets the id or slug and the timestamps.
3. **Propose an intent** for an existing project whose `intent` is `null` or an agent proposal still `to-review`, and with it write `discarded` (§12.1).
4. **Replace an agent proposal while it is still `to-review`, whoever proposed it:** the `proposal`, `proposedBy` (set to the replacing agent), `proposedAt` and `inputSha256` of an agent value, and the plain links of the entry it belongs to.
5. **Propose a link:** add a `ReviewedLink` with `origin: "agent"` and `status: "to-review"` (a piece for a family), when the target is not already listed (in any state, including rejected).

Everything else is refused (`not-allowed`, §16.2), including: creating or changing references (`source`, `result`, media, pins, notes, `lastIssued`); names; `library.json`; values with `origin: "user"`; `correction`, `status` and `reviewedAt`; plain links of an entry once its `Authored` value is reviewed or user-authored; changing or removing an existing `ReviewedLink`; reopening; deleting or merging anything. These are the user's, in the app (`tastelib init` writes the library's name). Agents never edit the user's words, and the user's words never live inside an agent field.

### 13.2 Review

- An agent proposal starts `to-review`. While it is `to-review`, an agent may replace it with a new proposal (new `proposal`, `proposedBy`, `proposedAt`, `inputSha256`).
- In the review queue, the user **accepts** it (`accepted`), **corrects** it (`corrected`: `correction` holds the user's complete version, same type as the proposal, never a partial patch) or **rejects** it (`rejected`). A link is accepted or rejected.
- Once reviewed, `proposal` is never modified again: what the agent said stays next to what the user decided. An agent cannot replace or delete a reviewed value; the user can reopen it (back to `to-review`, `correction` and `reviewedAt` cleared), and only then may an agent propose again.
- Rejected values and links are kept, so that agents can see what the user refused and do not propose it again.

### 13.3 Effective value

What consumers (the app, exports, agents reading files directly) use:

| Form | Effective value |
| --- | --- |
| `origin: "user"` | `content` |
| agent, `accepted` | `proposal` |
| agent, `corrected` | `correction` |
| agent, `to-review` | `proposal`, marked **tentative**: shown as such, never exported as the user's taste unless the user chooses to |
| agent, `rejected` | none |

For links: user links and accepted agent links count; `to-review` links are tentative; rejected links do not count.

An entry whose `Authored` value has no effective value (rejected) is kept only as a record of the user's "no". Consumers treat it as absent:

| Rejected | Means |
| --- | --- |
| piece interpretation | the piece counts as uninterpreted for browsing and exports, but not for §7.7: it is reviewed |
| family (`description`) | not a family: not listed, not offered for directions; its members count for nothing |
| glossary term | not in the glossary |
| guardrail | not a guardrail: never exported |
| taste-profile statement | not part of the profile |
| direction (`plan`) | not offered and never exported |
| intent | the project has no intent until the user writes one, or reopens it and an agent proposes again |

### 13.4 Staleness

When it stores an agent proposal for a piece, `tastelib` records `inputSha256`: the SHA-256 of the piece's note. If the user later edits the note, the proposal no longer matches; `validate` reports `proposal-stale` (a warning) for proposals that are `to-review` or `accepted`, and the app offers to reopen them. Other `Authored` values have `inputSha256: null`.

Staleness covers the note only. Moving or resizing a pin's region, or replacing the media, does not make a proposal stale.

## 14. Links and deletion

- Links: `PieceRef` (families, glossary, guardrails, taste profile, directions), `Slug` (`result.project`, `direction.family`), `DirectionId` (`result.direction`), `GuardrailId` (directions), and inside a reference `mediaId`, `frameMs` and interpretation keys.
- A link inside one file that points to nothing (a pin's `mediaId`, a `frameMs` with no frame, an interpretation key with no pin) is an error (`broken-local-link`).
- A link to another file that points to nothing is a warning (`dangling-link`): it can appear after a Git merge of edits from two computers, and readers ignore it. `tastelib` refuses a write that adds a new dangling link.
- Deleting a pin, a reference, a family, a guardrail or a direction removes every link to it in the same operation, following the multi-file write rules of §5 (sequential numbers are never reused, §4.3, so a link that survives a partial deletion or a Git merge shows up as `dangling-link` instead of pointing to a new item). Deleting a reference also deletes its folder in the media folder when it is present.

## 15. Versions and migrations

### 15.1 Version numbers

- `formatVersion` is a positive integer. Version 1 is this document. Every change to the format, even adding an optional-looking field, is a new version: there are no minor versions. **One exception, made once:** on 2026-11-04, before any tool had written a v1 file, `file-picker` was added to `source.via` (§7.1) without a new version. No other change to version 1 is allowed.
- Every JSON file in the library carries `formatVersion`. The library's version is the one in `library.json`. After a completed migration, every library file has it.
- The media marker (§6.1) carries its own `formatVersion`, independent of the library's: the media folder may be absent from a computer, or still syncing, when the library migrates. `tastelib` migrates the marker on disk when the media folder is next attached or written to; read-only commands migrate it in memory only. A marker version change never requires a library migration. The marker is not compared with `library.json` and never counts for `mixed-format-versions`. A marker with a version above what the tool supports is reported as `newer-format`, and the tool then writes nothing to the media folder (no captures, no deletions, no marker migration) until it is updated; the library itself stays usable.
- A tool that supports version N reads every version from 1 to N and writes only version N. A file with a version above N is reported as `newer-format` and is not checked further; a tool never writes to a library that contains one.

### 15.2 Reading and migrating

- Read-only commands (`tastelib validate`, reads through MCP, the app before its first write) migrate older files **in memory only**. `validate` reports `needs-migration` (info).
- Before its first write to an older library, `tastelib` migrates the whole library on disk, automatically, and says so. `tastelib migrate` does the same on request, and `tastelib migrate --dry-run` lists what would change.
- Library files whose version differs from `library.json` (the media marker is excluded, §6.1 and §15.1; for example, a file from a computer with another tool version arrived through Git) are reported as `mixed-format-versions` (a warning). A write to such a library runs the migration first (§15.3), which brings every file to the current version, even when `library.json` is already current.

### 15.3 How a migration runs

1. Read every file of the library. Validate each against the schema of its own version; a file with errors stops the migration before anything is written.
2. Apply the steps N → N+1 in order, in memory, up to the current version.
3. Validate the result against the current schemas, including the cross-file checks. If any error remains, stop: nothing has been written.
4. **Claim and back up.** Create `.tastelib/migration-backup/` with a non-recursive `mkdir`, which fails if the folder exists: only one process can own a migration (if it fails, resolve the existing backup as below). Immediately, before any copy, write `owner.json` atomically: the id of the migrating process, the computer's host name and the time of the claim. Then copy the files that will change or be deleted into the folder, each written atomically (temporary file, then rename, as in §5). Only when every copy is in place, write `manifest.json` atomically: the version migrated to, the files the migration will add, and `state: "in-progress"`. `owner.json`, every copy and the manifest are **durable** before step 5 begins (§5): each file is flushed to disk (`fsync`) before its rename, and the folder is flushed after the renames where the operating system supports it (not on Windows).
5. Write the changed and new files (atomically, §5), delete removed files, and write `library.json` last. Every file written here is flushed before its rename, and every folder touched (by a rename or a deletion) is flushed afterwards where the operating system supports it, so all of step 5 is durable before step 6 begins.
6. Rewrite the manifest atomically with `state: "done"`, durable in the same way before step 7.
7. Delete the backup: its copies and `manifest.json` first, then any `owner.json.taken-<random>` file left by a takeover (below), `owner.json` last, then the folder.

**Recovery.** No other write runs while `.tastelib/migration-backup/` exists; before any write, `tastelib` resolves it first, checking these cases in order:

1. **No `owner.json`** (or an unreadable one): the owner has just claimed the folder, or another process is taking it over (below), so the migration is treated as live. The write is refused with `write-conflict`, and the caller retries later.
2. **The owner is on another computer** (a different host name; possible only if `.tastelib/` itself is synced, or after this computer was renamed): its process cannot be checked, so the migration is treated as live. The write is refused with `write-conflict`.
3. **The owner's process is still running on this computer**, whatever the manifest says: a migration is under way. The write is refused with `write-conflict`.
4. **An unreadable `manifest.json`** (it does not parse, has the wrong shape, or names an unknown state): the state cannot be known, so nothing is deleted or restored. The write is refused with `write-conflict`, the backup is kept, and `tastelib doctor` reports it.
5. **The owner is gone, and the manifest says `"done"`:** the migration finished and only step 7 was missed. The backup is deleted as in step 7.
6. **The owner is gone, and there is no manifest:** it stopped while copying, before step 5, so the library files are untouched. The backup is deleted as in step 7, without restoring anything.
7. **The owner is gone, and the manifest says `"in-progress"`:** the migration was interrupted. The backed-up files are restored over the half-written ones and the files listed as added are removed; the restored files are flushed before their renames and the touched folders after them (where supported), so the restore is durable before the backup is deleted as in step 7. Then the migration runs again from step 1. Running it again is harmless, because steps are deterministic. This automatic restore also overwrites any of those files that changed after the interruption, for example through a `git pull`; their newer versions remain in Git history.

**Taking over a backup.** Several processes may find the same abandoned backup at once, so before acting on case 5, 6 or 7 a recoverer claims it exclusively:

1. It keeps the exact bytes of the `owner.json` it judged gone, and renames `owner.json` to a unique name (`owner.json.taken-<random>`). If the rename fails (the file is no longer there), it starts the case check again from the beginning.
2. A successful rename is not enough: a slower recoverer may have renamed the new, live claim of one that already took over. So it reads `owner.json.taken-<random>` and goes on only if its bytes are identical to the `owner.json` it judged gone.
3. If they differ, it has taken a live claim. It puts it back by creating `owner.json` exclusively (create-if-absent, `wx` / `O_EXCL`) with those bytes, deletes its `owner.json.taken-<random>`, and starts the case check again. If the exclusive create fails, it leaves the taken file for `tastelib doctor` and starts again.
4. If they match, it has won. It creates its own `owner.json` exclusively (`wx` / `O_EXCL`, so it can never replace someone else's), with its own process id, host name and time, and flushes it (durable, as in step 4). Until that file is complete, other writers see case 1 (no `owner.json`, or an unreadable one) and treat the backup as live. It then deletes its `owner.json.taken-<random>`, reads the manifest again, and goes on with the case it now finds.

Deleting `owner.json` last keeps a backup with copies or a manifest from ever being left without an owner by a normal deletion. A crash can still leave a folder with no `owner.json`: right after the `mkdir` in step 4, between deleting `owner.json` and removing the folder in step 7, or when a takeover winner crashes between its rename and creating its new `owner.json`. Such a folder stays in case 1 until the user resolves it with `tastelib doctor --resolve-migration`.

The version in `library.json` is not used to decide: a migration of a library with mixed file versions (§15.2) runs while `library.json` is already current. The backup folder, `owner.json` and `manifest.json` are internal to `tastelib` and are not part of the format; they stay on the computer, since `.tastelib/` is never committed. They are not a general lock: only a migration creates them, and an owner that crashed is detected from its process id. Process ids can be reused, so an unrelated process with the same id makes a crashed migration look live. In that case, and in cases 1, 2 and 4 when they do not clear by themselves, the write keeps failing with `write-conflict`. `tastelib doctor` then reports the backup with its owner and claim time, and `tastelib doctor --resolve-migration` lets the user decide, after confirming, whether to restore it or delete it ([design.md](design.md) §4). Before a restore it warns that restoring overwrites any of those files that changed since the migration was interrupted, for example through a `git pull`.

### 15.4 Writing a migration step

- One module per step, `packages/core/src/migrations/v<N>-to-v<N+1>.ts`, exporting a pure, deterministic, synchronous function from the whole library at version N (relative path → parsed JSON) to the whole library at version N+1. It may change, add, move or remove files. It touches only files at version N and passes others through unchanged.
- The schemas of every released version are kept, frozen, in `packages/core/src/schemas/v<N>/`; a step validates against the schemas of its two versions, never against "current".
- No step goes backwards: there are no down-migrations. Git history is the way back.
- Each step has the tests listed in [design.md](design.md) §15.

## 16. Validation and error reporting

`tastelib validate [<library>]` checks a library against this specification. Write commands (CLI and MCP) run the same checks on what they are about to write and refuse a write that would produce an error, reporting it in the same form.

### 16.1 Severities and exit codes

| Severity | Meaning | Fails `validate` |
| --- | --- | --- |
| `error` | The file breaks this specification. Readers skip it (and show it as broken); writers refuse to produce it. | yes |
| `warning` | Valid but needs attention: suspicious, not canonical or inconsistent across files. Never blocks reading or writing. | only with `--strict` |
| `info` | A state worth knowing that is not a problem. | never |

| Exit code | Meaning |
| --- | --- |
| 0 | no errors (and, with `--strict`, no warnings) |
| 1 | errors (or, with `--strict`, warnings) |
| 2 | could not run: not a library (no `library.json`), unreadable folder, bad arguments |

Options: `--json` (machine-readable report), `--strict` (warnings fail), `--checksums` (hash every media file instead of comparing sizes only). The CI check of the golden v1 library ([design.md](design.md) §15) runs with `--strict --checksums`.

### 16.2 Codes

Codes are stable identifiers and part of this contract; messages are not.

| Code | Severity | When |
| --- | --- | --- |
| `unreadable-file` | error | the file cannot be read |
| `file-too-large` | error | a JSON file over 8 MiB (§3.2) |
| `invalid-encoding` | error | not UTF-8, or a lone surrogate (§3.1) |
| `invalid-json` | error | not parseable as JSON |
| `duplicate-key` | error | an object has the same key twice (§3.2) |
| `newer-format` | error | `formatVersion` above what this tool supports, in a library file or the media marker (§15.1) |
| `schema-violation` | error | any rule of the file's schema: type, missing or unknown field, pattern, limit, or a rule across fields of the same file (one issue per rule broken) |
| `name-mismatch` | error | file or folder name does not match the id or slug inside (§5) |
| `duplicate-id` | error | the same id twice in one file |
| `broken-local-link` | error | a link inside one file that points to nothing (§14) |
| `media-folder-mismatch` | error | the media marker names another library (§6.1) |
| `media-outside-folder` | error | a media path resolves outside the media folder (§6.2) |
| `not-canonical` | warning | valid but not in canonical form: BOM, CRLF, whitespace, key or list order, needless `\u` escapes, proportions with more than 6 decimals (§3.3) |
| `mixed-format-versions` | warning | a library file's version differs from `library.json`; the media marker is excluded (§6.1, §15.2) |
| `dangling-link` | warning | a link to another file that points to nothing (§14) |
| `proposal-stale` | warning | a piece's note changed after the proposal (§13.4) |
| `duplicate-term` | warning | two glossary terms compare equal (§9) |
| `media-mismatch` | warning | a media file's size or checksum differs (§6.3) |
| `orphan-media` | warning | a media file no reference lists (§6.3) |
| `media-marker-missing` | warning | the media folder has no marker (§6.1) |
| `unexpected-file` | warning | an unknown file inside a format folder (§5) |
| `leftover-temp-file` | warning | a temporary file left by an interrupted write (§5) |
| `needs-migration` | info | the library is at an older version (§15.2) |
| `awaiting-sync` | info | a media file has not arrived yet (§6.3) |
| `media-not-checked` | info | no media folder is configured on this machine (§6.3) |

Write refusals use the same codes, plus two that only a write can produce:

| Code | Severity | When |
| --- | --- | --- |
| `write-conflict` | error | the file changed on disk between the writer's read and its rename (§5) |
| `not-allowed` | error | an agent write outside the allowlist (§13.1) |

### 16.3 Report

Each issue has:

- `severity` and `code` (above);
- `file`: the path relative to the library, with `/` on every operating system; for a file in the media folder, `media:` followed by its media path (for example `media:ref-20261104-k3x9ab/m1.webp` or `media:tastelib-media.json`); or `null` for an issue about the library as a whole (for example `media-not-checked` or `needs-migration`). Reports never contain absolute paths, so they can be shared without exposing a machine's folders;
- `pointer`: an RFC 6901 JSON Pointer to the value inside the file (for example `/pins/0/region/w`), or `null`;
- `message`: one sentence that names the field and what is expected. In the `--json` output (and in MCP results) messages are always in English, so agents and scripts see the same text on every computer. The human-readable output may be translated into the interface language.

Issues are sorted by `file` (`null` first), then `pointer` (`null` first), then `code`. The human-readable output (one line per issue, then a count) is meant for people and may change. The `--json` output is the contract:

```json
{
  "reportVersion": 1,
  "libraryFormatVersion": 1,
  "supportedFormatVersion": 1,
  "counts": {
    "error": 1,
    "warning": 1,
    "info": 0
  },
  "issues": [
    {
      "severity": "warning",
      "code": "dangling-link",
      "file": "families/quiet-editorial.json",
      "pointer": "/members/3/target",
      "message": "members[3].target: piece ref-20261101-q7w2e9#p2 does not exist."
    },
    {
      "severity": "error",
      "code": "schema-violation",
      "file": "references/ref-20261104-k3x9ab.json",
      "pointer": "/pins/0/region/w",
      "message": "pins[0].region.w: must be greater than 0."
    }
  ]
}
```

`libraryFormatVersion` is `null` when `library.json` itself cannot be read.
