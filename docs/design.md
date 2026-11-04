# Design

This document is the source of truth for how taste-library behaves. Behavior is defined here before it is built, and a change that alters behavior updates this document in the same pull request. The on-disk data format is specified separately in [format-spec.md](format-spec.md), the public contract that the tool, agents and integrations follow.

Sections marked **(to specify in Mx)** are placeholders that the named milestone fills in.

## 1. Purpose and audience

taste-library helps people inject their own design taste into AI-assisted design and avoid generic, regressed-to-the-mean interfaces. It serves a method in three steps: build a taste library of high-quality references grouped into aesthetic families; use a few focused tools; and build in sequence, never in one shot, with prompts made of four elements (**Aesthetic, Reference, Intent, Guardrails**), several directions side by side, then refinement.

Audience: people who already use AI coding agents (Claude Code, Cursor, Codex and similar). No design or development background is assumed for using the app itself.

## 2. Principles

1. **Local-first and private.** Runs on the user's machine, works offline, needs no account, sends no telemetry.
2. **Plain files are the truth.** The library is a folder of small, readable files. Any index is disposable and rebuilt from the files.
3. **The user's words are sacred.** Notes are stored verbatim. Interpretation is a separate layer, marked `to-review` until accepted or corrected.
4. **Intent only from briefings.** A project takes from a briefing only what it is, for whom, what users must do and why. Visual decisions are filtered out and listed as discarded.
5. **Agents work on the same files**, but write only through `tastelib` (CLI or MCP), which validates every write.
6. **The tool produces inputs and takes outputs back.** It does not integrate specific design or image services; it exports what they consume and imports what they produce.

## 3. Architecture

A TypeScript monorepo (pnpm workspaces):

```
packages/
  core/     data format: schemas, validated read/write, index, migrations
  server/   local server: API, URL capture, compression, video
  web/      user interface (React), translations en / pt-BR
  cli/      the `tastelib` command (init, open, doctor, validate, process, export, ...)
  mcp/      MCP connector for any agent
  testkit/  dev-only test helpers: generated fixtures, non-ASCII temp directories
  e2e/      end-to-end tests (Playwright)
agent-kit/
  claude-code/   Claude Code plugin (commands and skills)
  AGENTS.md      the same instructions for other agents
docs/
examples/sample-library/   only the maintainer's own or freely licensed media
```

Planned building blocks (each confirmed or replaced when its milestone starts): React + Vite for the interface; Hono for the local server; zod for validation; Playwright for page capture; sharp (WebP) and `ffmpeg-static` for media; Vitest and Playwright for tests; GitHub Actions on Linux and Windows; a pinned Node LTS.

### Toolchain (pinned in M0)

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| Node.js | 26 LTS ("Lithium"), at least 26.13.0 | `.nvmrc` (`26`); root `engines.node` (`>=26.13.0`), enforced by `engineStrict: true` in `pnpm-workspace.yaml` |
| pnpm | 12.16.1 | root `packageManager` (`pnpm@12.16.1`); pnpm downloads the pinned version itself, so Corepack is not needed |
| TypeScript | 6.0.3 | root `devDependencies`, exact version |
| `@types/node` | 26.6.6 | root `devDependencies`, exact version |
| Biome | 2.6.4 | root `devDependencies`, exact version |
| Vitest | 5.1.0 | root `devDependencies`, exact version |
| `@playwright/test` | 1.64.1 | root `devDependencies`, exact version |
| zod | 4.6.7 | `packages/core` `dependencies`, exact version (MIT) |

- Versions are exact (`savePrefix: ''`), the lockfile is committed and CI installs with `--frozen-lockfile`.
- pnpm settings live in `pnpm-workspace.yaml`. There is no `.npmrc`: since pnpm 11 it is read only for registry and authentication settings.
- Shared development tools (TypeScript, type packages, the linter and the test runner) are root `devDependencies`. Packages declare only their runtime dependencies, plus `@tastelib/testkit` as a `devDependency` when they have tests.
- No dependency runs install scripts today. A dependency that needs one must be listed in `allowBuilds` in `pnpm-workspace.yaml` (pnpm refuses unlisted ones), with the reason recorded in the same change.

### Packages and dependency graph

Every package is `@tastelib/<folder>`, `private`, version `0.0.0`, `"type": "module"`, with one `exports` entry (`types` → `./dist/index.d.ts`, `default` → `./dist/index.js`); `e2e` has none, because nothing imports it. The names are internal and can change with the final name (§16).

| Package | Depends on |
| --- | --- |
| `core` | nothing at run time (no other workspace package, ever); may list `testkit` as a `devDependency` |
| `server` | `core` |
| `mcp` | `core` |
| `cli` | `core`, `server` (`tastelib open` starts the server) |
| `testkit` | nothing |
| `e2e` | `testkit` (`devDependency`) |
| `web` | nothing yet; `react` and `react-dom` at run time (it runs in the browser, so it can use `core` only through a browser-safe entry point, decided when first needed) |

Each edge is both a `workspace:*` dependency and a TypeScript project reference. The graph has no cycles. `agent-kit/` is not a workspace package (it holds no TypeScript) and arrives in M3.

### Compiler configuration

- `tsconfig.base.json` holds the shared options: `target` and `lib` `es2025`, `module` `nodenext`, `types: []`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `forceConsistentCasingInFileNames`, `skipLibCheck`, `composite`, `declaration`, `declarationMap`, `sourceMap`. Paths use `${configDir}`, so every package compiles `src/` to `dist/` (`e2e` is the exception: it compiles `tests/` and its Playwright config, declarations only) and keeps its `.tsbuildinfo` inside `dist/` (deleting `dist/` forces a rebuild).
- Each package's `tsconfig.json` extends the base and adds only `types` and `references`, plus an `exclude` for `*.test.ts` when it has unit tests (type-checked by its `tsconfig.test.json`, §15). Node packages set `types: ["node"]` and write relative imports with the `.js` extension. `web` sets `module` `esnext`, `moduleResolution` `bundler`, `jsx` `react-jsx`, `lib` `["es2025", "dom"]`, emits declarations only (Vite produces the bundle) and writes relative imports without an extension.
- The root `tsconfig.json` is a solution file (`files: []`, references to every package and to the test configs) for editors and `tsc -b` from the root.
- The configuration avoids every option that TypeScript 6.0 deprecates, so moving to TypeScript 7 is a version bump (checked: 7.0.2 builds it unchanged).

### Build

- Each package's `build` script is `tsc -b`. `pnpm -r build` runs them in dependency order; `pnpm build` at the root does the same, and `pnpm clean` runs `tsc -b --clean`.
- `web`'s build is `tsc -b && vite build`: `tsc` type-checks and emits declarations, Vite writes the app to `packages/web/dist/app`. `pnpm --filter @tastelib/web dev` starts the Vite dev server.
- Scripts in any `package.json` call only cross-platform programs (`tsc`, `pnpm`, `vitest`, `playwright`, later `vite`). No shell built-ins (`rm`, `cp`, `mkdir -p`), no inline environment variables (`FOO=1 cmd`), no quoting or globbing that only a POSIX shell understands. A step that needs more is a Node script.

### Check command, lint and format

- `pnpm check` is the single gate, run locally, by agents (loop step 5) and in CI: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`. It stops at the first failure and exits non-zero.
- Biome does both linting (`recommended` rules; `pnpm lint` fails on warnings too) and formatting (2 spaces, double quotes, semicolons, 100 columns, LF). `pnpm format` rewrites files; `pnpm lint` and `pnpm format:check` only report.
- Biome is limited to code and data files (`.ts`, `.tsx`, `.js`, `.mjs`, `.json`), listed in `biome.json`. Markdown and YAML are not touched: it would reflow tables and prose in the design documents. It honors `.gitignore`.
- `pnpm typecheck` is `tsc -b`. `pnpm test` runs each package's `test` script when it has one (`pnpm -r --if-present test`); the test layout is in §15.
- `pnpm install` runs `prepare`, which runs `scripts/setup-hooks.mjs`: it sets `core.hooksPath` to `.githooks` in a Git checkout and does nothing elsewhere. New clones get the hooks without a manual step.
- CI runs `pnpm check`, then the end-to-end tests (`pnpm test:e2e:install`, `pnpm test:e2e`), on `ubuntu-latest` and `windows-latest` with the Node version from `.nvmrc` and the pnpm version from `packageManager`. The pnpm store is cached through `pnpm/action-setup` (`cache: true`); actions are pinned to full commit SHAs and `zizmor` audits the workflows.
- Dependabot watches the npm ecosystem weekly with a 7-day cooldown, groups development dependencies into one PR and uses the `chore(deps)` prefix.


## 4. Library, media and configuration

- A **library** is a folder (usually its own private Git repository) holding the data files described in [format-spec.md](format-spec.md).
- **Media** (images, full-page captures, videos, frames) lives in a separate **media folder**, outside any Git repository. It can be any folder, including one kept in sync by a file-sync service; the tool never depends on a particular service.
- The tool refuses a media folder that sits inside a Git working tree, and `tastelib doctor` checks it.
- Media that a library references but that has not arrived yet (for example, still syncing from another computer) is shown as **awaiting sync**, never as an error.
- **Per-machine configuration** (where the library and the media folder are on this computer) lives outside the library: `~/.config/tastelib/config.json` on Linux and macOS, `%APPDATA%\tastelib\config.json` on Windows. It is never committed. It also holds the other settings that belong to one computer: the interface language (§12) and where packs are exported (§10). The library itself holds no machine path.
- **The config file** is JSON with `version` (`1`) and these optional fields: `libraryPath`, `mediaPath`, `packsExportPath` (absolute paths in the form of the operating system that reads the file, with no `.` or `..` segments), and `language` (`en` or `pt-BR`). Unknown fields are refused. A missing file means the defaults (`{ "version": 1 }`). On Linux and macOS, `$XDG_CONFIG_HOME` is used when it is an absolute path, otherwise `~/.config`. A file over 1 MiB, or one that is not a regular file, is not read (a symbolic link to a regular file is followed, and the size is checked on the file it points to). Every error, including a failed write, is a `ConfigError` that names the config file and, when it concerns one, the field. It is written atomically (temporary file in the same folder, `fsync`, rename), and a write that fails validation leaves the old file untouched. A `mediaPath` inside a Git working tree (a `.git` folder or file in the path or any parent, after resolving symbolic links) is refused when the config is written.
- A media folder belongs to one library: it holds a marker file with the library's id (`tastelib-media.json`), so attaching the wrong folder is detected.
- Every write goes through `tastelib`, is validated first and replaces the file atomically (temporary file in the same folder, then rename). The exact rules, including how `tastelib validate` reports errors and warnings, are in [format-spec.md](format-spec.md) §16.
- **Concurrent writers** (the app and an agent at the same time) are handled by an optimistic check: just before the rename, the writer reads the file again and compares it with the bytes it started from; if they differ it refuses with `write-conflict`, and the caller reads again and retries (format-spec §5). There is no lock file. If real use shows conflicts the check cannot catch, M1 or later adds a lock. A write that touches several files (a deletion that removes links, a merge) is not atomic as a whole: `tastelib` checks every file before the first rename, writes the user's decision first and removes links after, and reports which files were written if it stops partway, so a partial stop leaves at worst dangling links, never a lost decision (format-spec §5).
- **Timestamps** are UTC. Because clocks on two computers may disagree, a writer sets `updatedAt` and `reviewedAt` to the later of now and their lower bound (format-spec §4.1), so a skewed clock never makes a write fail.
- **Format versions.** Read-only commands migrate an older library in memory only. Before its first write to an older library, or to a library whose files have mixed versions, `tastelib` migrates it on disk automatically and says so; `tastelib migrate` (with `--dry-run`) does it on request. A migration is validated completely before anything is written, keeps a backup until it finishes, and writes `library.json` last. The migrating process claims the backup folder with a non-recursive `mkdir` (only one can succeed), writes `owner.json` with its process id and host name before copying anything, copies the files into it atomically, and only then writes a manifest marked `in-progress`; the manifest is marked `done` after `library.json` is written, and only then is the backup deleted, `owner.json` last. The copies, `owner.json`, both manifest writes, every library file the migration writes and every file a recovery restores are flushed to disk (`fsync` of the file before its rename, and of each touched folder after it where the operating system allows it) before the next step, so a power cut can neither leave a backup that recovery would trust but that is empty, nor a manifest marked `done` over library files that never reached the disk. No other write runs while a backup exists: with no owner file yet, an owner on another host, a live owner, or an unreadable manifest, the write fails with `write-conflict` (retry later) and the backup is kept; with the owner gone, a backup marked `done` or with no manifest (the copy never finished; the originals are untouched) is deleted, and one `in-progress` is restored and the migration runs again (format-spec §15.3). Several processes that find the same abandoned backup race for it by renaming `owner.json` to a unique name. A rename that succeeds wins only if the renamed file holds exactly the bytes of the `owner.json` the recoverer judged gone; otherwise it has taken the live claim of a recoverer that already won, puts it back with an exclusive create (`wx`) and checks again. The winner creates its own `owner.json` exclusively too, so it can never replace someone else's, deletes the renamed file, and recovers; the others check again from the start. A restore during recovery overwrites files that changed after the interruption (for example through a `git pull`); their newer versions remain in Git history. When a backup stays stuck (a reused process id, a crash right after the claim, just before the folder is removed, or by a takeover winner before it created its new `owner.json`, an unreadable manifest, or a computer that was renamed and now looks like another host), `tastelib doctor` reports it, and `tastelib doctor --resolve-migration` shows what it holds and, after the user confirms, restores or deletes it. Before a restore it warns that restoring overwrites any of those files that changed since the interruption, for example through a `git pull`. Unlike the rest of `.tastelib/`, the backup folder must never be deleted by hand or by cleaning tools such as `git clean -X` while a migration is in progress or interrupted (format-spec §5). The version in `library.json` does not decide this, because a library with mixed file versions migrates while `library.json` is already current. There are no down-migrations; Git history is the way back. The media folder's marker has its own version: it is migrated on disk when the media folder is next attached or written to, and in memory only by read-only commands.

## 5. Capture

Capture happens on the computer, in the app, by pasting or dropping:

- **Screenshots and images**, stored compressed (WebP).
- **Page URLs**, captured as a full-page image by a headless browser, on the user's request only.
- **Videos and GIFs**, for motion; stored compressed, with frames extracted for pinning.

New captures land in an **inbox** until processed.

**(to specify in M2)** size limits, compression settings, capture timeouts, frame extraction.

## 6. Notes and pins

- Each reference has a **free-text note** in the user's own words.
- **Pins** are boxes drawn on an area of an image or of a video frame. Each pin is a **piece** with its own note. The whole-reference note counts as a piece covering the whole image.
- A pin is **positive** (take this) or **negative** (not this). Negative pins are the source of **guardrails**. There are no whole-image anti-references.
- Regions are stored as proportions (0–1) of the media size, so they survive resizing.
- The whole-reference note is piece `p0`; pins are `p1`, `p2`… A pin on a video sits on one of its extracted frames. Pieces are addressed across the library as `<ref-id>#p<n>`.
- The app stores notes exactly as typed; the only change is that line breaks are stored as `\n`. A note that breaks a rule (for example, a control character) is refused with a message, never silently altered.

## 7. Interpretation and review

- Interpretation runs in **batches through an agent** ("process my new references"). For each piece, the agent proposes vocabulary, keywords, screen types, components, design aspects and, for negative pins, a guardrail.
- Everything the agent writes is marked **`to-review`**. In the app, a review queue offers **Accept**, **Correct** or **Reject**. A correction is the user's complete version, stored next to the original proposal, which is never modified after review. Rejected proposals are kept, so agents see what the user refused and do not propose it again.
- The user's own words are never altered.
- Agent writes are an allowlist (format-spec §13.1): through `tastelib` (CLI or MCP), an agent can only add proposals marked `to-review` (piece interpretations, new families, glossary terms, guardrails, profile statements, directions, an intent with its discarded list, and pieces proposed for a family), set the links of an entry it created while that entry is still `to-review`, and replace an agent proposal while it is still `to-review`, whoever proposed it (`proposedBy` is updated). Everything else is refused with `not-allowed`: references (capture, media, pins, notes), names, user-authored values, corrections, review statuses, links of reviewed entries, reopening, deleting and merging. Those are the user's, in the app.
- While a proposal is `to-review`, an agent may replace it. Once reviewed, an agent cannot replace or delete it; the user can reopen it, and only then can an agent propose again.
- `tastelib` records a fingerprint of the note each proposal was based on. If the user edits the note later, the proposal is flagged as stale and the app offers to reopen it.
- Until it is reviewed, a proposal is **tentative**: shown as such and not exported as the user's taste unless the user chooses to.
- Who writes which field, and the effective value consumers use, are specified in [format-spec.md](format-spec.md) §13.

## 8. Organization and taste tools

- **Aesthetic families emerge** from the collection. The agent proposes a name, a meaning and a vocabulary; the user accepts, renames or merges.
- Browsing also works by **screen or page type**, **component** and **design aspect**.
- Taste tools: **family pages**, a **taste profile** (likes, rejections, contradictions), a **vocabulary glossary**, and **side-by-side comparison**.
- A family's pieces are listed in the family; the agent proposes pieces, and the user accepts or rejects each one. A family's slug is fixed at creation; renaming changes its name only. Merging moves the pieces and replaces links to the merged family.
- The taste profile is stored as separate statements, each reviewed like any proposal. Its Markdown view is rendered when needed, not stored.
- Guardrails are proposed from negative pins into one list of candidates; a candidate becomes approved when the user accepts or corrects it.

**(to specify in M4)**

## 9. Project spaces

- A project space pulls pieces from the library and adds its own layer: intent, directions, packs and results.
- **Intent:** the agent drafts it from any briefing dropped in, keeping only what, for whom, what users must do and why. Visual decisions, styles, colors, fonts and named directions are filtered out and listed as **discarded**. The user edits the result.
- **Directions:** the agent proposes about five (family + pieces + why it fits); the user adjusts.
- **Results loop:** screenshots of generated versions are pasted back into the project and pinned. They become references that sharpen the next packs and the taste profile. A result is an ordinary reference that names its project and direction; there is no separate results store.
- The briefing itself is not stored in the library: only the intent drawn from it and the list of what was discarded. Agents never use the discarded list as input for directions, packs or prompts.

**(to specify in M5)**

## 10. Export

An export is a folder `pack-<date>/` with:

- `README.md`: how to use the pack (directions side by side, then the build sequence).
- One subfolder per direction with `prompt.md` (Aesthetic · References · Intent · Guardrails), `image-prompts.md`, and `refs/` (a crop of each piece plus the whole image with the area highlighted).

Where packs are exported is a per-machine setting (§4), not part of the library. By default the export folder contains its own `.gitignore` that ignores everything in it, so a pack placed inside any Git repository is never committed by accident. The user can turn this off per export.

**(to specify in M5)**

## 11. Agent kit

- Agents read library files and media directly, and write only through `tastelib` (CLI or MCP).
- Claude Code plugin commands:

| Command | What it does |
| --- | --- |
| `/taste:process` | Interprets the inbox and writes everything as `to-review`. |
| `/taste:families` | Proposes or updates families from the collection. |
| `/taste:profile` | Updates the taste profile and the glossary. |
| `/taste:intent <briefing>` | Drafts the intent, filtering out everything visual, and lists what was discarded. |
| `/taste:directions <project>` | Proposes about five directions (family + pieces + why). |
| `/taste:pack <project>` | Exports the four-element packs and image prompts. |
| `/taste:results <project>` | Processes generated versions that came back. |

- `AGENTS.md` carries the same instructions for other agents.

**(to specify in M3)**

## 12. Internationalization

The interface is in English with a Brazilian Portuguese option from the first release. All user-facing strings go through the translation layer from day one. The README has a pt-BR translation in `docs/pt-BR/`.

**Translation layer (`packages/web/src/i18n`).** A small in-house layer, no dependency: one message file per language (`messages.en.ts` is the reference and defines the `MessageKey` type; `messages.pt-BR.ts` is typed `Record<MessageKey, string>`), `translate(language, key, values)` with `{name}` placeholders, and an `I18nProvider` / `useI18n()` pair for React. Components never contain literal user-facing text; they call `t("key")`. The first language is taken from the browser preferences (any `pt` tag gives `pt-BR`, otherwise `en`) and a selector switches it at once. A missing key fails `pnpm check` twice: `tsc` refuses a catalog without every key, and a unit test checks that both catalogs have the same keys, no empty message and the same placeholders. Storing the choice in the per-machine config (§4) arrives with the server.

The interface language is a per-machine setting (§4). The library's `language` (in `library.json`) is something else: the language in which agents write proposals, so the vocabulary stays in one language whichever computer the library is opened on. Validation codes are stable identifiers in English. Messages in `tastelib validate --json` and in MCP results are always in English, so agents and scripts see the same text everywhere; the human-readable output may be translated into the interface language.

## 13. Portability

- Linux and Windows are both first-class (macOS is expected to work).
- No script that runs on only one operating system. Git hooks are POSIX `sh`, which Git runs on every platform. Workflow helper scripts are plain Node (`.mjs`, no build step, no dependencies), which runs on every platform.
- Text files use LF (`.gitattributes`); the tool reads either line ending.
- Library files are UTF-8 without a BOM, LF, in a canonical JSON form (format-spec §3), so the same data gives the same bytes on every system.
- File names inside a library and a media folder come only from identifiers (ASCII, lowercase, never a Windows reserved name), so they behave the same on case-insensitive file systems and never depend on Unicode normalization. Only the folders the user chooses may have non-ASCII names.
- Paths with non-ASCII characters (for example `Usuário`) are tested in CI.

## 14. Security

See [SECURITY.md](../SECURITY.md) for the sensitive surfaces. The local server listens on the loopback interface only and rejects cross-origin requests.

Library and media paths are built only from identifiers that match the format's patterns, and a media path that resolves outside the media folder (for example through a symbolic link) is refused (format-spec §6.2). JSON files over 8 MiB are not parsed. Validation reports name files relative to the library and never print absolute paths.

**(to specify in M0 and M2)**

## 15. Testing

- Unit tests next to the behavior; pure logic (schemas, parsers, naming, the intent filter, migrations) always has them.
- End-to-end tests drive the app in a browser.
- Test data is **synthetic and generated at test time**. No third-party images, pages or videos are ever committed.
- CI runs every check on Linux and Windows, including a non-ASCII path and both line endings in inputs.
- Required checks: `tastelib validate` passes on the sample library; migrations are tested; a made-up briefing full of visual decisions must leak none of them into the intent, and the discarded list must show them all.

### Test layout

- **Unit tests** use Vitest (5.1.0). They sit next to the code as `src/<name>.test.ts`, are excluded from each package's build (`tsconfig.json` excludes them) and are type-checked by a `tsconfig.test.json` in the package (see `packages/testkit`). Every package except `e2e` has a `test` script (`vitest run`, with `--passWithNoTests` while a package has no tests yet); the root `pnpm test` runs them all and is part of `pnpm check` (§3). A package that gets its first test also gets `tsconfig.test.json`, its reference in the root `tsconfig.json`, and a `devDependencies` entry for `@tastelib/testkit`.
- **End-to-end tests** use Playwright (`@playwright/test` 1.64.1) in `packages/e2e`, as `tests/*.e2e.ts`. They are not part of `pnpm check`, because they need a browser download (about 120 MiB). First time: `pnpm test:e2e:install`; then `pnpm test:e2e`, which builds `testkit` first because the tests import its `dist/`. Each test starts its own local HTTP server on an OS-assigned port and serves generated content; nothing touches the network. The package has no `test` script on purpose, so `pnpm test` skips it.
- **Shared helpers** live in `packages/testkit` (`@tastelib/testkit`, private, dev-only). It has no workspace dependencies and nothing ever lists it under `dependencies`. `core` stays free of other workspace packages at runtime; once `core` has tests it lists `testkit` as a `devDependency` only (a test-time edge, not part of the dependency graph in §3). It offers:
  - `makePng(width, height, seed)` and `makeBmp(width, height, seed)`: valid images built byte by byte (no image library), deterministic per seed (same pixels; PNG bytes are stable only within one Node version, because zlib output can change, so tests that need exact bytes use `makeBmp`). JPEG and WebP fixtures arrive with the encoder chosen for compression (M2).
  - `makeHtmlPage({ title, body, images, crlf })`: small HTML pages, with either line ending.
  - `createSeededRandom(seed)`: the PRNG behind the images (mulberry32).
  - `withTempDir(fn)`: a fresh temporary directory whose path contains non-ASCII characters (`.../Usuário-日本`), removed afterwards.
- **Determinism:** fixed seeds, no real network, no dependence on directory listing order or locale; tests that list directories sort the result.
- **No committed binaries:** images are generated at runtime; CI's media check enforces it.

### Format and migration tests

- **Golden libraries.** `packages/core` keeps one hand-written, synthetic fixture library per released format version (JSON only; media is generated at test time). A fixture is frozen once its version is released: it is never edited, only added to.
- **Schemas** have positive and negative tests for every rule in format-spec, including the canonical serializer (same data, same bytes; `not-canonical` on BOM, CRLF and wrong order) and non-ASCII text in notes.
- **Each migration step N → N+1** is tested for: the golden vN library migrates to a library that validates against the vN+1 schemas; the specific changes the step makes; determinism (two runs give identical bytes); files already at vN+1 pass through unchanged; an interrupted run (stopped after some writes, with the manifest still `in-progress`) is restored from the backup and reaches the same result as an uninterrupted one; the same for an interrupted migration of a library with mixed file versions, where `library.json` is already current; a crash while copying the backup (owner gone, no manifest yet) leaves the originals untouched, and the backup is deleted without restoring; two concurrent recoverers of an `in-progress` backup with a dead owner: only one wins the `owner.json` rename and restores, and the other re-checks and does not restore; a slow recoverer that renames the new `owner.json` of one that already took over finds different bytes, puts the claim back, and does not act; a migration still copying (owner alive, no manifest yet) is not deleted by a second writer, which gets `write-conflict`; a backup folder with no `owner.json` yet, or with an owner on another host, is treated as live; an unreadable manifest is not deleted (the write gets `write-conflict` and the backup is kept); `owner.json` is removed last when a backup is deleted; a backup marked `done` whose owner is gone is deleted without touching the files; and with two concurrent migrations only one claims the backup folder, while the other gets `write-conflict` and does not restore the backup of a live owner.
- **The chain:** the golden v1 library migrates through every step to the current version and validates. A test fails if `CURRENT_FORMAT_VERSION` has no step module, schema folder and golden library for every version up to it.
- **Validate** has one test per issue code (format-spec §16.2), checking severity, file, pointer and exit code, on Linux and Windows and under a non-ASCII path.
- **Writes** have tests for every allowed agent write and for refusals with `not-allowed` (one per refused kind in format-spec §13.1), for `write-conflict` (the file changes between read and rename), for a multi-file write that stops partway (the primary change is kept, only `dangling-link` warnings remain, and the report lists the files written and not written), for slug derivation (a long name, a name that shortens to a reserved word, a taken slug near 64 characters), for clock skew (a lower bound in the future), and for sequential ids that are never reused after a deletion.

The check command is in §3.

## 16. Release and publishing

- The repository is private until the designed-UI milestone is done, and is built as if public from the first commit.
- Before going public (M7): choose the license, choose the final name, write the README and install guide, ship a sample library with freely licensed media, test the MCP connector with another agent, release 1.0, enable private vulnerability reporting and a ruleset on `main`, and scan the repository and its history for third-party media, personal data and machine paths.
- Any publishing step goes through a release checklist issue: the agent shows it, explains each item and waits for the maintainer to confirm each one. Publishing runs in a separate workflow with a protected environment and manual approval.

## 17. Milestones

| Milestone | Delivers |
| --- | --- |
| M0 Foundation | monorepo, code standards, tests, CI on Linux and Windows, translations, `format-spec.md` v1, per-machine config, portability rules |
| M1 Core & format | schemas, validated read/write, index, migrations; `tastelib init / validate / doctor` |
| M2 Capture & notes | paste image, URL and video; compression; inbox; notes; positive and negative pins; awaiting sync; ends with a real-use checkpoint |
| M3 Agent kit I | writes through CLI and MCP; plugin with `/taste:process`; review queue |
| M4 Organization & taste | families, family pages, browsing, glossary, taste profile, comparison |
| M5 Project spaces | filtered intent, directions, pack export, image prompts, results loop; ends with a real-use checkpoint |
| M6 Designed UI | the tool's own interface, designed with its own method |
| M7 Release | see §16 |

## 18. Decision log

| Date | Decision | Alternatives rejected |
| --- | --- | --- |
| 2026-11-04 | Local app in the browser + agent kit (Claude Code plugin, MCP connector). | Desktop-only app (a wrapper stays possible later without a rewrite); hosted service. |
| 2026-11-04 | TypeScript throughout. | Python or Go/Rust back end with a web front end: two languages, weaker fit with Node-based agents and Playwright. |
| 2026-11-04 | Plain files are the source of truth; the index is disposable. | A single SQLite file: opaque to agents and to Git diffs. |
| 2026-11-04 | Tool and personal libraries live in separate repositories; media lives outside Git. | One repository: third-party media would sit next to code that will be public; media in Git or Git LFS makes repositories heavy. |
| 2026-11-04 | `docs/design.md` is the source of truth and holds this decision log; `docs/format-spec.md` is the separate data contract. | Separate ADR files: the same decision would be written in two places. |
| 2026-11-04 | Issue-driven workflow: one issue, one branch, one squash-merged PR, reviewed by a separate agent. | Direct commits to `main`. |
| 2026-11-04 | Until the repository is public, `main` is protected by Claude Code permission rules, a `pre-push` hook and merging only on green CI; a GitHub ruleset is enabled at M7. | Paid plan for branch protection on a private repository. |
| 2026-11-04 | One issue per session: the maintainer runs `/clear` after each issue and types `continue`; `scripts/loop.mjs status` reads GitHub and says what to resume or start. | Relying on the agent's memory of earlier sessions. |
| 2026-11-04 | Workflow helper scripts are Python, standard library only; product code stays TypeScript. (Superseded on 2026-11-04 by the next row.) | Shell scripts (not portable to Windows); TypeScript before the toolchain exists in M0. |
| 2026-11-04 | Workflow helper scripts are plain Node (`.mjs`, no build step, no dependencies), tested with `node --test` inside `pnpm check`; no Python anywhere. | Python (a second language and toolchain for contributors and CI once the TypeScript toolchain existed); shell scripts (not portable to Windows). |
| 2026-11-04 | The maintainer's own Git identity in commits is allowed under the "nothing personal" rule. | Rewriting history to a handle-only identity. |
| 2026-11-04 | Node 26, the Active LTS line since 2026-10-28 (26.13.0), pinned by `.nvmrc` and `engines` with `engineStrict`. | Node 24: in maintenance since October 2026. An exact patch in `.nvmrc`: blocks security releases without adding reproducibility (the lockfile does not depend on the Node patch). `devEngines.runtime` (pnpm downloads Node): more machinery than a version file every tool already reads. |
| 2026-11-04 | pnpm 12.16.1 pinned by `packageManager`; pnpm fetches the pinned version itself. | Corepack: no longer shipped with Node 25 and later. A global pnpm with no pin: versions drift between machines and CI. |
| 2026-11-04 | TypeScript 6.0.3, with a configuration that already builds unchanged on 7.0. Revisit when the linter chosen in M0 supports TypeScript 7. | TypeScript 7.0.2 (native compiler): no stable programmatic API until 7.1, and `typescript-eslint` 8.72 accepts only `typescript <6.1.0`. Speed does not matter at this size. Running both compilers (7 to build, 6 for tools): two type checkers that can disagree. |
| 2026-11-04 | Biome 2.6.4 for lint and format. It has its own parser and does not depend on the `typescript` package, so the TypeScript 7 move is not blocked by the linter. | ESLint + Prettier + `typescript-eslint`: three tools and about a dozen dependencies, and `typescript-eslint` ties the linter to the TypeScript version (see the TypeScript row). Biome's type-aware rules are weaker; `tsc` already covers type errors. |
| 2026-11-04 | Weak-copyleft dependencies (MPL-2.0) are accepted when they are development-only, unmodified and not bundled. First case: `lightningcss`, pulled by Vite through Vitest (and later by the `web` build). | Keeping hard rule 7 strict: it would exclude Vite and Vitest for one transitive CSS tool. A test runner without Vite (`node:test`): weaker tooling, and `web` brings the same package anyway. |
| 2026-11-04 | Packages build with `tsc -b` and project references, emitting `dist/` with declarations. | A bundler (tsup, tsdown, Rolldown) for the Node packages: an extra dependency that emits nothing `tsc` cannot. Bundling for distribution is decided at release (M7). Source-only packages run through a loader: the CLI and the MCP connector must run on plain Node. |
| 2026-11-04 | Vitest for unit tests (in `pnpm check`), Playwright for end-to-end tests (separate `pnpm test:e2e`), shared fixture helpers in a dev-only `packages/testkit`, images built by hand (PNG, BMP) instead of with an image library. | Jest (slower with ESM and TypeScript); Playwright inside `pnpm check` (forces a 120 MiB browser download on every install and CI run); helpers copied into each package; `sharp` or `pngjs` for fixtures (a native or extra dependency for something about 60 lines do). |
| 2026-11-04 | `format-spec.md` v1 is frozen. Every later change, even before 1.0, is a new integer `formatVersion` with a tested migration. | Keeping the format loose until 1.0: the maintainer's real library exists from the M2 checkpoint and must survive upgrades. Major/minor format versions: with a migration for every change, one integer is enough. |
| 2026-11-04 | Strict schemas: every field is always present (`null` or `[]` when empty), unknown fields are errors, and there is no extension field. | Ignoring unknown fields: typos and agent mistakes would pass silently. An `extensions` object: unvalidated data in the library, and a way for an agent to store interpretation outside the review layer. Optional fields: two ways to say "empty", and agents reading files must handle both. |
| 2026-11-04 | Canonical JSON: UTF-8 without BOM, LF, two-space `JSON.stringify` output, keys in spec order, list entries sorted by id. Readers accept BOM, CRLF and any layout and report `not-canonical`. | JSONC or JSON5 (comments do not survive a rewrite through the tool); YAML (an extra parser, implicit typing); Markdown files with front matter (the draft taste profile: no per-statement review, hard to validate); insertion-ordered lists (two computers appending to the same list always conflict in Git, while entries sorted by random id usually do not). |
| 2026-11-04 | Identifiers: `ref-<UTC date>-<6 Crockford base32>` for references; `lib-`, `gr-`, `term-`, `st-` with random parts for entries; sequential `m<n>`, `p<n>`, `d<n>` inside one file, never reused (the file records the highest number ever issued in `lastIssued`), with links removed on deletion; `p0` is the whole-reference note. File names come only from identifiers. Slugs are always shortened to 64 characters before the reserved-name and taken checks, and shortened again so that a `-2`, `-3`… suffix still fits. | UUIDs or ULIDs (long and unreadable in paths and prompts); sequential global numbers (collide between computers that sync through Git); reusing the next number after the highest in use (a link that survived a partial deletion or a merge would silently point to a new pin; a counter turns it into a visible `dangling-link`); random local ids (`p-k3x9`: harder to say and read in prompts than "piece 3"); 4 random characters (the draft: with 100 captures a day on each of two computers, about a 1% chance of a collision every day; 6 characters make it about 1 in 100 000); file names from user text (Unicode normalization differs between file systems, plus case and reserved-name problems). |
| 2026-11-04 | Slugs of families and projects are fixed at creation; renaming changes the name only. | Slugs that follow the name: every rename rewrites links in many files, breaks the file's Git history and the links in packs already exported. |
| 2026-11-04 | Timestamps are UTC with millisecond precision and `Z` (`toISOString()` output); the interface shows local time. | Local offsets (two computers in different time zones make ordering ambiguous); epoch numbers (unreadable in files). |
| 2026-11-04 | Interpretation is an `Authored<T>` value: `origin: "user"` with `content`, or `origin: "agent"` with an immutable `proposal`, a status (`to-review`, `accepted`, `corrected`, `rejected`) and a complete `correction`. Links sit next to it, never inside it. Agents can write only proposals. Review gains **Reject**. | Editing the proposal in place (loses what the agent said); corrections as partial patches (hard to read and to validate); interpretations in a separate file per reference (two files to keep in step, and more Git conflicts); deleting rejected proposals (the agent would propose them again); Accept and Correct only (rejecting would mean "correcting" to empty). |
| 2026-11-04 | Proposals record a SHA-256 of the note they were based on; a changed note makes them stale (warning). | No tracking: an accepted interpretation silently stops matching the user's words. Storing a copy of the note: duplicates the user's words. |
| 2026-11-04 | Derived, not stored: a reference's state (inbox, processed, reviewed) and its families (listed only in the family). Guardrail proposals live only in `guardrails.json`, with their source pins. | Stored state and two-sided links (the draft): two places that can disagree after a partial write or a Git merge. A `guardrail` field in pin interpretations (the draft): the same rule in two places. |
| 2026-11-04 | The taste profile is `taste-profile.json`, statements reviewed one by one; Markdown is rendered on demand. | `taste-profile.md` (the draft): no review status per statement, cannot be validated, and agents would edit it as free text. |
| 2026-11-04 | A generated result is an ordinary reference with a `result` link to its project and direction. | A `results/` folder with its own schema (the draft): a second copy of capture, pins and review. |
| 2026-11-04 | The briefing is not stored; only the intent and the discarded list are. | Storing the briefing: its visual directions stay where agents read them again, and it may hold client details the user does not want in Git. |
| 2026-11-04 | The library holds no machine path: the interface language and the export destination are per-machine settings; `library.json` `language` is the language of agent proposals. | Interface language in `library.json` (the draft): a setting of one person on one computer, not of the data. Export destination in `project.json` (the draft): an absolute path that is wrong on every other computer. |
| 2026-11-04 | Media paths `<ref-id>/m<n>[-t<ms>].<ext>` relative to the media folder, with `/`; each file has its size and SHA-256; a marker file ties the media folder to its library id. A missing file is "awaiting sync" (info); a mismatch is a warning; checksums are hashed only with `--checksums`. Video frame times are integer milliseconds. | Content-addressed file names (unreadable, and a re-encode renames the file); absolute paths; BLAKE3 (a dependency, where SHA-256 is in `node:crypto`); a mismatch as an error (a half-synced file is not a broken library); hashing every file on every run (slow on videos); frame times in float seconds (the draft: rounding makes equality unreliable). |
| 2026-11-04 | Migrations are pure whole-library steps N → N+1 with frozen schemas and golden fixtures per version; the runner validates everything in memory, claims the backup folder with a non-recursive `mkdir`, writes `owner.json` (process id, host name) before any copy, copies files atomically and writes the manifest (`in-progress`) only after every copy, all flushed to disk before the migration writes library files, then the library files it writes (and later any it restores) flushed the same way before the next step, marks it `done` only after `library.json` is written, and resolves a leftover backup before any other write (no owner file yet, an owner on another host, a live owner or an unreadable manifest: `write-conflict`, backup kept; owner gone and `done` or no manifest: delete, `owner.json` last; owner gone and `in-progress`: restore and re-run; a recoverer first claims the backup by renaming `owner.json` and checking that the renamed bytes are those it judged gone, and writes its own `owner.json` with an exclusive create, so only one acts). A stuck backup is resolved by the user with `tastelib doctor --resolve-migration`. The backup folder is the one part of `.tastelib/` that must not be deleted by hand. A write to a library with mixed file versions migrates first. The media marker has its own version, migrated on disk when the media folder is next attached or written to (in memory only by read-only commands), and is excluded from `mixed-format-versions`; a marker newer than supported blocks writes to the media folder only. No down-migrations. | Migrating each file lazily when it is next written: libraries would stay mixed forever. Per-file steps only: cannot move data between files. Resuming from the half-written files: a step written for version N would see some files already at N+1. Deciding from the version in `library.json`: a mixed-version library migrates while `library.json` is already current, so an interrupted run would look finished. Restoring whenever the manifest is missing: a crash while copying would "restore" partial copies over intact originals. Recording the owner in the manifest: until the manifest exists (all copies made), a second writer could not tell a running copy from a crashed one and would delete it. Treating an unreadable manifest as missing: a damaged `in-progress` manifest would delete the only copy of the original files. Renames without `fsync`: after a power cut a backup could exist by name with empty contents and recovery would restore nothing, or `done` could reach the disk before the library files it vouches for. Recovering without a claim: two processes could restore the same backup at once, one deleting it while the other is still restoring. A claim by rename alone: a slower recoverer could rename the fresh claim of one that already took over and also "win". A hard link as the exclusive claim: not available on every file system (FAT, exFAT, some synced folders), while an exclusive create is. Treating every `in-progress` manifest as interrupted: a second process would restore files under a migration still running. (The backup folder is not the general lock file rejected in the concurrency row: only a migration creates it, and a crashed owner is detected from its process id.) Tying the marker to the library version: the media folder may be missing or still syncing when the library migrates. Down-migrations: twice the code for a path nobody tests in real use. |
| 2026-11-04 | Agent writes are an allowlist: only new or replaced proposals that are still `to-review`, the links of an entry still `to-review`, and the discarded list of an intent proposal. Everything else is refused with `not-allowed`. | A denylist of protected fields (the draft of this spec): any field added later is writable by agents until someone remembers to protect it. |
| 2026-11-04 | Concurrent writes use an optimistic check: re-read and compare bytes just before the rename, refuse with `write-conflict` on a mismatch. Writers set `updatedAt` and `reviewedAt` to the later of now and their lower bound. Multi-file writes check every file first, write the user's decision first and links after, and report partial results. | Treating multi-file writes as atomic (no portable way across files without a journal, which is more machinery than one person's library needs). A general lock file for every write: stale locks after a crash, and lock files inside a folder synced through Git or a sync service (migrations alone use their backup folder as a claim; see the migrations row). Comparing `updatedAt` only: two writes in the same millisecond, or a skewed clock, would pass. Rejecting timestamps earlier than their bound at write time: a computer whose clock is behind could not edit files from one that is ahead. |
| 2026-11-04 | Duplicate keys in a JSON object are an error (`duplicate-key`). | Accepting the last value, as `JSON.parse` does: a hand-resolved Git conflict could silently drop data. |
| 2026-11-04 | Notes and every other piece of the user's words are stored verbatim, with one exception: line breaks are stored as `\n` (a pasted `\r\n` or `\r` becomes `\n`). Nothing else is trimmed, normalized or corrected. | Storing `\r\n` as typed: the same note would give different bytes and fingerprints on Windows and Linux, and `proposal-stale` would fire when a note merely crossed computers. Refusing notes that contain `\r`: pasting from many Windows programs would fail for no reason the user can see. |
| 2026-11-04 | `--json` validation messages (and MCP results) are always in English; only the human-readable output may be translated. A library-wide issue has `file: null`. | Translated messages everywhere: agents and scripts would see different text per computer. A made-up file name for library-wide issues: a path that does not exist. |
| 2026-11-04 | `tastelib validate` reports three severities (error, warning, info) with stable codes, a library-relative `/` path, a JSON Pointer and a plain message; exit 0, 1 or 2; `--strict` fails on warnings; `--json` is the contract. Links within one file are errors; links to other files that point to nothing are warnings, and new ones are refused at write time. | Errors only (awaiting sync and stale proposals are not failures); numeric codes (unreadable); absolute paths in reports (expose a machine's folders when shared); cross-file dangling links as errors (one Git merge could block every write to the file until it is fixed by hand). |
| 2026-11-04 | The per-machine config is a versioned JSON file (`version: 1`) validated with zod (a strict object: unknown fields are refused), and a media folder inside a Git working tree is refused at write time. | A loose schema that ignores unknown fields (a typo in a field name would silently do nothing); checking the media folder only in `tastelib doctor` (the bad setting would already be saved). |
| 2026-11-04 | The interface translation layer is original code (typed message catalogs, a React context, about 80 lines). React 19 and Vite 8 with `@vitejs/plugin-react` build the app; `jsdom` runs component tests in Vitest. | `i18next` / `react-i18next`, `react-intl` or `lingui`: a dependency, ICU or plural machinery and runtime message loading for two languages and short strings; revisit if plurals or dates in messages become real needs. Tests with a real browser only: slower, and kept for the end-to-end suite. |
