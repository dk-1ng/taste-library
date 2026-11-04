# Library format specification

**Status: draft.** Version 1 is written and frozen in milestone M0. Until then, everything here is a sketch and may change.

This is the public contract for a taste-library library on disk. The tool, agents and third-party integrations follow it. Behavior that is not about the data format lives in [design.md](design.md).

## 1. Principles

- Plain, human-readable files (JSON, Markdown). One reference per file.
- Every file carries `formatVersion`. Older versions are migrated automatically, and every migration is tested.
- The user's words are stored verbatim. Interpretation is a separate block with a review status.
- Media is not part of the library folder. It lives in a separate media folder and is referenced by relative path and checksum.
- Agents read files directly and write only through `tastelib` (CLI or MCP), which validates against this specification.

## 2. Library folder

```
<library>/
  library.json                 # format version, interface language, name
  references/<ref-id>.json     # one reference per file
  families/<slug>.json         # name, meaning, vocabulary, pieces, status
  glossary.json
  taste-profile.md
  guardrails.json              # candidate and approved guardrails
  projects/<slug>/
    project.json               # intent, what was filtered out, export destination
    directions.json
    results/                   # generated versions that came back
  .tastelib/                   # index and cache: never committed, rebuilt locally
```

## 3. Media folder

```
<media>/
  <ref-id>/original.webp | page-full.webp | clip.mp4 | frames/
```

## 4. Reference (sketch)

```jsonc
{
  "id": "ref-20261104-k3x9",
  "formatVersion": 1,
  "createdAt": "2026-11-04T12:00:00Z",
  "source": { "url": "https://example.com/", "site": "example.com", "via": "paste | url-capture | drop" },
  "media": [
    { "id": "m1", "kind": "image | page | video", "file": "ref-20261104-k3x9/original.webp",
      "width": 1600, "height": 1200, "sha256": "..." }
  ],
  "note": { "text": "the user's words, never changed", "lang": "pt-BR" },
  "pins": [
    { "id": "p1", "mediaId": "m1", "region": { "x": 0.08, "y": 0.12, "w": 0.4, "h": 0.3 },
      "frameTime": null, "polarity": "positive | negative", "note": "free text" }
  ],
  "interpretation": {
    "p1": {
      "summary": "...", "vocabulary": [], "keywords": [], "screenTypes": [], "components": [],
      "aspects": [], "guardrail": null,
      "status": "to-review | accepted | corrected", "correction": null,
      "by": "agent", "at": "2026-11-04T12:05:00Z"
    }
  },
  "families": [],
  "status": "inbox | processed | reviewed"
}
```

- `region` values are proportions (0–1) of the media's width and height.
- `frameTime` is the video time in seconds for a pin on a video frame, or `null`.
- The whole-reference note is treated as a piece covering the whole image.

## 5. To specify in M0

Exact schemas for every file, identifier rules, timestamps and time zones, text encoding and line endings, the media checksum, the migration mechanism and the error reporting of `tastelib validate`.
