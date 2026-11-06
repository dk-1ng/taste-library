# Design

This document is the source of truth for what taste-library does, defined before it is built; a change to what users or agents see updates it in the same pull request. The data format is the separate contract [format-spec.md](format-spec.md).

**Scope.** This document records what is visible from outside (the commands, their options, codes and outputs, the files the tool writes, and the public API of `core`) and the promises the tool keeps, in one or two sentences each. How the code keeps a promise (steps, order, timings, formulas, retries, internal checks) is not recorded here: the code and its tests are the record, with a doc comment where a reason would otherwise be lost. Plans live in the issues; the decision log (§18) holds one row per live decision, and the evidence lives in the issue or pull request it names. The last full version, with the mechanisms and evidence this document no longer holds, is [in Git history](https://github.com/dk-1ng/taste-library/blob/dd26ee09f1aa017faa793dd58e75ada503547bd2/docs/design.md): history, not contract.

**Reviews grade by promises** (§14 "Threat model"). A blocker is code that breaks a promise or a contract of this document or of format-spec, or a hard rule, under a condition in scope of §14; or a change to what users or agents see that the docs do not record. Code that differs from a description of mechanism is not a blocker: the fix is to remove the description.

**Size.** This document has at most 12,000 words: `pnpm docs:size` (`scripts/design-size.mjs`, part of `pnpm check`) fails above that. Raising the limit is a maintainer decision, recorded in §18.

Read it by section, headings first (`CLAUDE.md`, "Reading the docs").

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
  cli/      the `tastelib` command (init, validate, doctor, config; later migrate, open, export, ...)
  mcp/      MCP connector for any agent
  testkit/  dev-only test helpers: generated fixtures, non-ASCII temp directories
  e2e/      end-to-end tests (Playwright)
agent-kit/
  claude-code/   Claude Code plugin (commands and skills)
  AGENTS.md      the same instructions for other agents
docs/
examples/sample-library/   only the maintainer's own or freely licensed media
```

Planned building blocks, each confirmed when its milestone starts: React + Vite; Hono for the local server; zod for validation; a headless Chromium or Firefox for URL capture, driven by an engine #45 chooses; image and video encoding chosen by #44, without `sharp` or `ffmpeg-static` (§18); Vitest and Playwright; GitHub Actions on Linux, Windows and macOS.

### Toolchain and checks

The tools and their exact versions are pinned in the root `package.json` (`packageManager`, `engines`: Node 26.13.0 or later), `.nvmrc`, `pnpm-workspace.yaml` and each package's `package.json`, with the lockfile committed; compiler options are in `tsconfig.base.json`, lint and format in `biome.json`, CI in `.github/workflows/`.

- `pnpm check` is the single gate, locally, for agents and in CI on Linux, Windows and macOS: lint, format check, the size of this document, typecheck, test and build.
- Scripts in any `package.json` call only cross-platform programs; anything more is a plain Node script. No dependency runs install scripts unless `pnpm-workspace.yaml` allows it, with the reason recorded.

### Packages and dependency graph

Every package is `@tastelib/<folder>`, `private`, with one `exports` entry (`e2e` and `web` have none; `core` adds `./browser`). The names can change with the final name (§16).

| Package | Depends on |
| --- | --- |
| `core` | nothing at run time, ever; may list `testkit` as a `devDependency` |
| `server` | `core` |
| `mcp` | `core` |
| `cli` | `core`, `server` (`tastelib open` starts the server) |
| `testkit` | nothing |
| `e2e` | `testkit` (`devDependency`) |
| `web` | `react`, `react-dom`; from M2 `core` only through `@tastelib/core/browser` |

The graph has no cycles. `agent-kit/` is not a workspace package and arrives in M3.

### Core modules and API

`@tastelib/core` is the Node entry and exports everything; `@tastelib/core/browser` exports the pure modules, which run unchanged in Node and in a browser. Pure modules import only `zod` and each other and use no Node-only global, as a Biome rule checks (a lint rule, not a sandbox); code that touches the operating system lives in `src/node/`, and test-only code never under `src/`. Pure code gets SHA-256 from its caller.

**Public API for M2 and M3** (names indicative; the shapes are the decision):

- `openLibrary(root, options)` reads every library file once and returns `{ ok: true, library }` or `{ ok: false, code, message }` with `code` `not-a-library` (no `library.json`) or `unreadable-folder` (exit 2 on the command line). Long-running processes keep the `library` handle open.
- `library.snapshot()` returns an immutable **snapshot**, refreshed first (§4 "Index"): `formatVersion` (of `library.json`, or `null`), `files` (by relative path: kind, exact bytes, fingerprint (`null` when built in memory), `formatVersion`, status `valid`, `invalid`, `newer` or `unreadable`, the parsed value when valid, and the file's issues at its own version), `migrated`, `issues` (sorted as in format-spec §16.3) and `index`. With nothing changed it returns the previous snapshot itself.
- **The migrated view.** For an older or mixed library (format-spec §15.2) whose migration can run, `migrated` is the library as the migration would leave it, built in memory by the same steps as the migration and `--dry-run`, at migrated paths and the current version, fingerprints `null`; otherwise `null`.
- **The report**, `reportOf(registry, snapshot, mediaIssues?)` (pure), is the format-spec §16.3 report of the snapshot's and the media issues, with `media-not-checked` when `mediaIssues` is not given (no media folder). With a migrated view, cross-file issues come from it, at migrated paths, saying they were found after migration to version N; when the migration cannot run, its blocking errors are reported, so the report has an error exactly when a write would refuse to migrate.
- `checkMedia(snapshot, mediaRoot, { checksums })` returns the media issues, so a refresh never hashes media.
- `attachMediaFolder(library, path)` (§4 "Attaching a media folder") returns `attached` (`marker` `written`, `kept` or `migrated`), `refused` (a code, message and issues) or `failed` (`io-error`). `guardMediaWrite(mediaFolder, libraryId)` runs before every media write: it refuses without this library's valid marker or with a newer one (`newer-format`), and migrates an older one on disk; `readMarker` migrates in memory only. `findGitWorkTree(path)` and `isInside(inner, outer)` implement §4 "Comparing folders".
- `library.write(build, options)` (§4 "Writing library files"): `build` gets the fresh, gated snapshot and returns a **plan** `{ changes, skipped, blockedBy? }`: `changes` an ordered list of `{ path, next }` (`next` `null` to delete), the first being the primary change (format-spec §5); `skipped` the files or folders left alone, `{ path, reason }`, passed to the result; `blockedBy` files the plan relies on unchanged. A plan that breaks its own shape throws (a bug). Pure deletion planners (pin, reference, family, guardrail, direction) build the plans of §4 "Deleting". Writes through one handle run in order; across processes the optimistic check decides. The clock is an option.
- `library.migrate(options)` migrates on disk with no plan and returns `current` (nothing written, not even `.tastelib/`), `migrated` (`from`, `to`, and the files `changed`, `added` and `removed`, by path), `refused` (`issues`) or `failed` (a `failure`), each with `notices`.
- **Issues** are plain data in the shape of format-spec §16.3, `{ severity, code, file, pointer, message }`, `file` relative with `/` (or `media:…`, or `null`), each code at its format-spec §16.2 severity, also in a refusal.
- **Errors that are not validation issues** are results with their own codes, `not-a-library`, `unreadable-folder` and `io-error` (`{ code: "io-error", operation, file, errno, message }`, `file` relative). Expected failures never throw; an exception is a bug.
- **A write result** has a `status` and `notices`: `written` (the files written and `skipped`), `unchanged` (nothing written, no `updatedAt` moved), `refused` (`issues`: validation errors, a new `dangling-link`, `write-conflict`, `newer-format`, a migration that cannot run, later `not-allowed`) or `failed` (`io-error`, or `not-a-library` or `unreadable-folder` when the folder stopped being a readable library). `refused` and `failed` list the files `written` and `notWritten`, both non-empty only after a partial multi-file write. `notices` holds `{ code: "migrated", from, to }` exactly when the write migrated the library on disk, whatever the status.

## 4. Library, media and configuration

- A **library** is a folder (usually its own private Git repository) holding the data files of [format-spec.md](format-spec.md).
- **Media** lives in a separate **media folder**, outside any Git repository, which any file-sync service may keep in sync. Its marker (`tastelib-media.json`) holds the library's id, so attaching the wrong folder is detected. A media folder inside a Git working tree, inside the library folder or containing it, and a non-empty folder without a marker, are refused with no exception ("Attaching a media folder"). Media that has not arrived yet is shown as **awaiting sync**, never as an error.
- **Per-machine configuration** lives outside the library and is never committed: `~/.config/tastelib/config.json` on Linux and macOS (under `$XDG_CONFIG_HOME` when it is absolute), `%APPDATA%\tastelib\config.json` on Windows. The library holds no machine path.
- **The config file** is JSON with `version` (`1`) and the optional fields `libraryPath`, `mediaPath`, `packsExportPath` (absolute paths of the operating system that reads the file, without `.` or `..` segments) and `language` (`en` or `pt-BR`, §12). Unknown fields are refused; a missing file means `{ "version": 1 }`; a file over 1 MiB, or not a regular file, is not read. Every error is a `ConfigError` naming the file and the field, if any. It is written atomically, never when invalid, and a `mediaPath` inside a Git working tree is refused.
- **Every write** goes through `tastelib`, is validated first and replaces files atomically; concurrent and multi-file writes follow format-spec §5, with no lock file. Timestamps are UTC, never earlier than their lower bound (format-spec §4.1), so a skewed clock never makes a write fail.
- **Format versions.** Read-only commands migrate an older library in memory only; the first write to an older or mixed library migrates it on disk (format-spec §15.3) and says so (the `migrated` notice). While its backup `.tastelib/migration-backup/` exists, every write is refused with `write-conflict`; recovery (#39), `tastelib migrate` and `doctor --resolve-migration` (#43) wait for the first format v2 change (§18). Never delete the backup by hand or with `git clean -X`. No down-migrations: Git history is the way back. The media marker has its own version, migrated on disk at the next attach or media write.
- **Deleting** a pin, a reference, a family, a guardrail or a direction writes the primary change first (the pin and its interpretation removed; the reference or family file deleted; the guardrail or direction entry removed, its file kept; `lastIssued` kept), then removes every link to it (format-spec §14) in path order; a direction's `family` and a `result.direction` become `null`. A removed link moves the `updatedAt` of what held it and edits no `Authored` value. Running a deletion again completes it, or is `unchanged` when nothing is left. **Deleting a reference** then deletes its media folder through the media write guard (format-spec §6.1); a media folder not attached or not synced does not block it, and a folder that turns up later is `orphan-media`.

### Reading library files

- **Every rule reports once:** a malformed value is reported by its own rule, and the rules across fields (duplicate ids, local links, kind against type, `updatedAt` against `createdAt`, `lastIssued`) still check the rest. Exception: a list over its maximum stops the rules of the objects above it.
- **Links stay inside the library.** Until #92 builds it, the reader follows every link; this bullet and §14 state the behavior once built. Every file the tool reads or writes in a library, and every folder it lists or creates there, is the library's real folder or lies under it once links and junctions are resolved; the library folder itself may be a link.
  - A file that leads outside, or into the library's own `.tastelib/` or `.git/`, is `unreadable-file` and never opened; a format folder that does so cannot be listed (`unreadable-file`, everything under it unresolved). Messages never say where a link leads. `library.json` follows the same rule, also when a command looks for its library. A `.tastelib/` that leads outside refuses every write with `unreadable-file` at `.tastelib`.
  - Other links that stay inside are followed. A write never follows a link at a file path: it replaces or removes the link.
  - **Setups that are not supported:** a format folder or file moved elsewhere through a link; move the whole library folder, or link the library folder itself.
- **I/O.** Over 8 MiB is `file-too-large` (format-spec §3.2); a read error, or a path that is not a regular file, is `unreadable-file`, and a link to `/dev/zero` never hangs the reader. A file that disappears after the listing is treated as deleted. Results are ordered by path.
- **The strict reader** is an original RFC 8259 parser that never recurses. Invalid UTF-8 is `invalid-encoding` (pointer `null`), a lone surrogate `invalid-encoding` at its pointer, a repeated key (compared after decoding) `duplicate-key` at that key, all of them reported; the first syntax error stops it with `invalid-json` (pointer `null`, line and column in the message). A `__proto__` key is an ordinary unknown field.
  - **Nesting is limited to 64 levels:** deeper input is `invalid-json` ("nested deeper than 64 levels"), never thrown, as RFC 8259 §9 allows.
- **Which files are listed.** The format folders are listed with the layouts of every supported version (format-spec §15.2), so a file at a path only an older version has is read and migrated, never ignored; one at a path its own version lacks is `schema-violation` at `/formatVersion` and blocks a migration.
- **Validation.** A file with any error is `invalid`; its value is not used by the index or by other files' checks.

### Writing library files

`library.write` writes the plan or ends with a result (§3), after the write gate (below) and every check.

- **Plan.** A plan may not replace or delete a file that is not `valid`, nor depend on one through `blockedBy`: the write is refused with its issues, because only the user repairs a file with errors. With #92, a change under a folder that could not be listed is refused with that folder's issue.
- **Authorize** (M3): agent writes outside the allowlist (format-spec §13.1) give `not-allowed`.
- **Validation.** One invalid change refuses the whole plan, with the issues of every invalid file. A new link (one its entry, or its field of the same file, did not have) must resolve as the whole plan leaves the library, otherwise `dangling-link` (a warning) refuses the write; so does a new link into a file that is not `valid`. Links already dangling stay. Warnings such as `proposal-stale` never block.
- **Timestamps.** The write sets every `updatedAt`: a changed file or entry gets the later of now and its `createdAt`; a new file, entry or pin gets `createdAt` and `updatedAt` equal to now; `createdAt` never changes; reviews set `reviewedAt` to the later of now and `proposedAt`. All files of one write get the same time. A plan that changes nothing is `unchanged` and writes nothing.
- **Replace.** Files are written canonically (format-spec §3.3) in plan order, primary change first, each through a temporary file `.<name>.tmp-<8 Crockford characters>` in its folder. Every target is checked against the bytes read and against a new migration backup before the first rename (`write-conflict`, nothing written) and again before its own; a stop lists the files before it in `written` and the rest in `notWritten`. Format folders are created when first needed and removed again when the write ends `refused` or `failed`.
- **Proportions.** Regions are rounded per axis to integer millionths, after validation: a valid region never becomes invalid, a tiny size never becomes 0, rounding is idempotent, a region with at most 6 decimals is never changed, and no value moves by more than 1e-6.
- **Durability.** Every write flushes its temporary file before the rename, so a power cut leaves the previous file or the new one, never an empty one. A flush that fails after the rename is `failed`, the file counted as written. A library folder that is gone fails the write as `openLibrary` does.
- **Links on the way to a file** (with #92). A target whose folder is outside the library, or in its `.tastelib/` or `.git/`, fails with `io-error` (operation `realpath`, `EINVAL`) before anything is touched.
- **Windows renames and deletions.** On Windows a rename or deletion failing with `EPERM`, `EACCES` or `EBUSY` (a file held open by an antivirus, a sync client or an editor) is retried for up to 2 seconds, rechecking the target, then fails with `io-error`. A temporary file that cannot be deleted stays (`leftover-temp-file`, or the `temp-files` check of `doctor` at the top level).
- **Cleanup only on result paths.** A write that ends `refused` or `failed` leaves no temporary file or created folder (except as just said); a process that dies, or a bug that throws, leaves the disk as it was then.

### Write gate

Before the plan is built, every write:

1. **Refreshes** the snapshot (§4 "Index").
2. **Checks the migration backup:** with #92, a `.tastelib/` that leads outside refuses with `unreadable-file`; while `.tastelib/migration-backup/` exists, the write is refused with `write-conflict` and the backup kept.
3. **Checks `library.json`:** missing (or the folder unreadable), the write ends `failed` with `not-a-library` (or `unreadable-folder`); not `valid`, `refused` with its issues.
4. **Refuses newer files**, with one `newer-format` issue per file.
5. **Migrates an older or mixed library** on disk, then goes on with the notice `{ code: "migrated", from, to }`, kept whatever happens next: `to` is the current version, `from` that of `library.json`, or the lowest present when `library.json` is current. A migration that cannot run writes nothing, and the write is `refused` with the blocking files' issues.

Media writes have their own guard on the marker (format-spec §6.1).

### Migration runner failures

A file changed outside `tastelib` during a migration stops it with `write-conflict`. A migration that fails after it created its backup cleans up before it returns: the library is as before (or migrated, with the `migrated` notice), the backup is gone, and the write is `failed` (`io-error`) or `refused` (`write-conflict`); a file it had not reached is never touched. If the cleanup fails too, the backup stays; a long-running process finishes its own cleanup before its next write, unless the backup or the files changed meanwhile.

### Links to files with errors

A cross-file link resolves if its target file is `valid` and holds the target, and is dangling if the file is absent or holds no such target. A link into a file that is not `valid`, or under a folder that could not be listed, is **unresolved**: no `dangling-link` (the broken file has its own error), it counts for nothing in the index, a write that adds it is refused, and link removal skips that file and lists it in `skipped` (`{ path, reason: "invalid" | "unreadable" | "newer" }`; an unlisted folder is `unreadable`), so a broken file never blocks the user's decision. When the file that holds the thing being deleted is in that state, the deletion is refused with its issues (`blockedBy`).

### Index

The index is derived data, kept **in memory only**, inside the snapshot; nothing is cached under `.tastelib/`.

- **What it holds** (M2–M4): references with their pieces, derived state (format-spec §7.7) and `result` link; each piece's families (`to-review` ones tentative); which targets exist; and backlinks, every `(file, pointer)` linking to a target, dangling and unresolved included. An older or mixed library is indexed from the migrated view (§3).
- **How it is built.** An updated index always equals a fresh rebuild from the same files, and the checks, the gate and the index resolve links by one rule.
- **Freshness.** Before every answer and every write, a refresh lists the format folders and checks every file's metadata, re-reading what changed; the next refresh sees every change, even a second one within the file system's timestamp resolution (2 seconds on FAT). No `fs.watch` in M1; the M2 server may use it only as a hint.
- **Performance budget**, a test on Linux, Windows and macOS CI, on a library generated with a fixed seed: 5000 references (1–2 media items, 0–5 pins, about 60% of pieces interpreted, about 3.4 KB per file), 50 families of 100 members, 300 glossary terms and one project, about 17 MB. Opening it takes **under 5 seconds**; a refresh with nothing changed, or one reference changed, **under 0.5 seconds**; one single-file write, gate and flush included, **under 1 second**. On a CI runner a line also passes within `factor × baseline + overhead` over a plain baseline timed in the same run, with constants named in the test and the same on every system. **Three runs:** each line and baseline is timed three times and the fastest is checked (§18).

### Command line

`tastelib` (`packages/cli`) is the command people and agents run. M1 delivers `init`, `validate`, `doctor` and `config`; `migrate` and `doctor --resolve-migration` come with the first format v2 change (#43); `open` (M2), agent writes (M3) and `export` (M5) follow. It only parses, calls `core` and prints. The report of `validate` is format-spec §16; the rest is the command line's own contract (maintainer decisions in §18).

#### Building and running

- The command is the `bin` of `packages/cli` (`tastelib` → `dist/bin.js`). It checks the Node version against `engines.node` (26.13.0, also in `packages/cli/package.json`) before loading anything else: an older Node gets `node-too-old`, never a syntax error. It never cuts off its own output; an `EPIPE` ends it quietly. `--version` prints the `cli` package's version.
- Before a release, run `pnpm build`, then `pnpm tastelib <arguments>` from the repository root (relative paths resolve from there) or `node <repository>/packages/cli/dist/bin.js`. `tastelib` on `PATH` is decided in M7.

#### Arguments

- Usage errors (`unknown-option`, `missing-argument`, `unexpected-argument`, `invalid-argument`, defined in "Codes") exit 2 with a message of ours, never Node's, ending "Run `tastelib <command> --help`."; `invalid-argument` names the argument.
- A value that starts with `-` is written `--name=-value` (`--name -value` is `missing-argument`); `--` ends the options.
- `--help` or `-h` prints text help and exits 0, whatever else is on the line, `--json` included; `tastelib --help` lists the commands, `tastelib` alone prints a usage on standard error (`missing-argument`). No negative flags, no short forms but `-h`.
- A path argument is resolved against the current folder by its text; the config stores that string, never resolved further or Unicode-normalized (§13).

#### Which library a command uses

`validate`, `doctor`, `migrate` and `doctor --resolve-migration` use, in this order:

1. The `<library>` argument, which must be a library folder itself (`not-a-library`).
2. The current folder or the nearest above it with a `library.json`, on the real path. A `library.json` is passed over only when it parses into an object without an `id` matching `LibraryId` (another tool's file); any other one, even damaged, stops the search, so `validate` reports its errors.
3. `libraryPath` from the config (`not-a-library`, naming the field and the config file).
4. Otherwise `no-library` (exit 2).

`doctor` reports these as checks instead. The text output names the library and where it came from, with no absolute path the user did not type; `validate --json` at exit 0 and 1 stays exactly the format-spec §16.3 report.

**The media folder** of a command is `--media <folder>` (only `validate` has it), otherwise `mediaPath`, but only when the library in use is the configured `libraryPath`; otherwise none, and `validate` reports `media-not-checked`.

**The config is read only when a command needs a value from it**, so `tastelib validate <folder> --media <folder>` runs with a broken config; a needed value from a broken config is `config-error`.

#### `tastelib init`

`tastelib init [<folder>] --name <name> --language <tag> [--git] [--json]`

- `<folder>` defaults to the current folder; a missing one is created only when its parent exists.
- `--name` (required) is the user's words, stored exactly as given; one that is not a `Name` (format-spec §4.2) is `invalid-argument`, naming the rule it breaks.
- `--language` (required, no default) is the `LanguageTag` of agent proposals (format-spec §5.1); a bad tag is `invalid-argument`.

**Refusals,** in this order, before anything is written (exit 2, nothing changed): `not-a-folder`, `parent-folder-missing`, `already-a-library`, `inside-library`, `inside-media-folder`, `library-files-present`, `gitignore-unusable`, `config-error`, `media-inside-library` (the configured `mediaPath` is in the folder), then with `--git` `git-nested-repository` and `git-not-found`.

**What it writes:** the folder when missing; `.gitignore`, created with `# Working area of taste-library, never committed` and `.tastelib/`, or given the line `.tastelib/` when no line ignores the folder; last, `library.json` (a new `LibraryId`, the name, the language, `createdAt`), so running `init` again after a failure works. A new library passes `tastelib validate --strict` (only `media-not-checked`).

**Git.** Without `--git`, `init` never runs `git` and adds the notice `suggest-git-init` (no working tree) or `in-git-working-tree` (inside another repository's). With `--git`, `.git` already in the folder gives the notice `git-already-initialized`; otherwise `git` is found by absolute path in the absolute entries of `PATH` only (executable on Linux and macOS, `git.exe` on Windows), never by name or in the current or library folder (§14), and `git init` runs after the files are written (`git-failed` on failure; the library exists). `init` never commits.

**The config.** `init` sets `libraryPath` when it is unset, and otherwise keeps it with the notice `library-path-kept`; setting it while `mediaPath` is set adds the notice `media-folder-of-other-library`. A failed config write is `config-error` (the library was created). `init` attaches no media folder. Order: files, `git init`, config, notices.

#### `tastelib config`

`tastelib config [show] [--json]` · `tastelib config set <key> <value> [--json]` · `tastelib config unset <key> [--json]`

- **`show`** (the default) prints the file's path, whether it exists, and every field; it creates nothing.
- **`set`** accepts `libraryPath` and `mediaPath` in M1 (`language` with M2, `packsExportPath` with M5); **`unset`** accepts all four and touches no folder or marker; another key is `invalid-argument`. A broken config is never overwritten (`config-error`).
- **`set libraryPath <folder>`** needs a library (`not-a-library`); when `mediaPath` holds another library's marker, the notice `media-folder-of-other-library` says so. `mediaPath` never changes implicitly.
- **`set mediaPath <folder>`** attaches the folder to the library at `libraryPath` (`library-path-not-set`; `not-a-library`, `library-json-invalid` or `newer-format` for that library) and writes `mediaPath` only when attaching succeeds.

#### Attaching a media folder

`attachMediaFolder` in `core` is the only code that attaches a folder. The first check that fails refuses (exit 2) and writes nothing:

1. `not-a-folder`: not a folder, or a link to a folder that does not exist.
2. `media-inside-library`: the library folder or a folder inside it.
3. `library-inside-media`: a folder that contains the library folder.
4. `media-inside-git`: inside a Git working tree.
5. The marker `tastelib-media.json`: unreadable or invalid is `media-marker-unreadable` (its issues at `media:tastelib-media.json`); another library's is `media-folder-mismatch`; a newer one is `newer-format`; this library's is attached again (an older marker migrated on disk), with the notice `media-already-attached`.
6. `media-folder-not-empty`: not empty ("Empty" below) and no marker.
7. `parent-folder-missing`.

Then the folder is created if missing and the marker `{ "formatVersion": 1, "libraryId": "<id>" }` written canonically and atomically; a marker changed meanwhile is `write-conflict` (also from `guardMediaWrite`). An I/O failure is `io-error` with `file` `media:tastelib-media.json`, `media:` or `library:`.

**Comparing folders.** "Inside" and "the same folder" are decided on real folders by file-system identity, once links, junctions and mapped drives are resolved, so case, Unicode normalization and short names never matter; without an identity, real paths are compared after `normalize("NFC")`, case-insensitively on Windows and macOS.

**Empty.** A folder is empty when every entry has one of these names (compared after `normalize("NFC")` and `toLowerCase()`): `.DS_Store`, `.localized`, `Icon\r`, `desktop.ini`, `Thumbs.db`, `.directory`, `.dropbox`, `.dropbox.attr`, `.dropbox.cache`, `.stfolder`, `System Volume Information`, `$RECYCLE.BIN`, `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `.TemporaryItems`, and `.tastelib-media.json.tmp-<8 Crockford characters>`. The list is closed: any other entry, an empty subfolder or a link included, makes it not empty. A media folder that lost its marker is therefore refused: attach an empty folder and move the reference folders into it.

#### `tastelib doctor`

`tastelib doctor [<library>] [--json]` checks this computer's setup and writes nothing (no config, folder, marker, migration or `git`). Each check has a stable `id`, a `status` (`pass`, `info`, `warn`, `fail` or `skip`), a `code` (not for `pass` or `skip`), a `message` and, unless it passes, a `hint`. A format-spec §16.2 code keeps its severity (error `fail`, warning `warn`, info `info`). A check whose input is unknown is `skip`; `media-outside-library` and `media-marker` run only for the library at `libraryPath`. In this order:

| Check | Results |
| --- | --- |
| `node` | `pass`; `fail` `node-too-old` |
| `config` | `pass`; `warn` `config-missing`; `fail` `config-error` |
| `library-path` | `pass`; `warn` `library-path-not-set`; `fail` `not-a-library`, `unreadable-folder`; `skip` when the config fails |
| `library` (the one in use) | `pass`; `fail` `not-a-library`, `unreadable-folder`; `skip` when there is none |
| `library-format` | `pass`; `info` `needs-migration`; `warn` `mixed-format-versions`; `fail` `library-json-invalid` (with its issues), `newer-format` |
| `migration-backup` | `pass`; `fail` `migration-backup-present` (writes are refused; never delete it by hand) |
| `temp-files` (top of the library, format folders, top of the media folder, the config folder's `.config-<hex>.tmp`) | `pass`; `warn` `leftover-temp-file`, with the files |
| `gitignore` | `pass`; `warn` `gitignore-missing-tastelib` |
| `git` | `pass`; `warn` `library-not-in-git` |
| `media-path` | `pass`; `warn` `media-path-not-set`; `fail` `media-folder-missing`, `not-a-folder`; `skip` when the config fails |
| `media-outside-git` | `pass`; `fail` `media-inside-git` |
| `media-outside-library` | `pass`; `fail` `media-inside-library`, `library-inside-media` |
| `media-marker` (an older marker passes) | `pass`; `warn` `media-marker-missing`; `fail` `media-folder-mismatch`, `media-marker-unreadable`, `newer-format` |

**Exit code:** 0 when no check fails, 1 when one does, 2 when `doctor` cannot run (bad arguments).

#### `tastelib migrate`

`tastelib migrate [<library>] [--dry-run] [--json]` (#43) runs `library.migrate`: a current library writes nothing, not even `.tastelib/` (exit 0); a migration lists each file `changed`, `added` or `removed`, by path (exit 0); a refusal is `migration-blocked` (with the issues), `newer-format` or `write-conflict` (exit 1), a failure `io-error` (exit 2); with recovery (#39), the notice `migration-recovered`. `--dry-run` only reads and lists what `would change`, `would add` and `would remove`; a migration backup gives `migration-backup-present` (exit 1).

#### `tastelib doctor --resolve-migration`

`tastelib doctor --resolve-migration [<library>] [--json]` (#43) shows a migration backup (state, owner, the files a restore would put back and remove) and offers **restore** (for a manifest `in-progress` or unreadable), **delete** and **cancel**, warning that a restore overwrites files changed since the interruption. It acts only on the full word typed in a terminal (standard input and output, no `--json`), any other answer cancelling (exit 0); without a terminal it is `not-interactive` (exit 2); no flag acts without it. A backup that changed meanwhile is `write-conflict` (exit 1).

#### Output

- **Streams.** Text results go to standard output, errors to standard error. With `--json`, standard output receives exactly one JSON document and an LF, whatever the exit code, and standard error stays empty.
- **Codes.** Every error and notice has a stable code ("Codes" below), part of the contract; messages are not, and are English in M1 (§12). Text output shows `error <code>: <message>` or `note <code>: <message>`, then `hint: …`.
- **`--json` of `validate`** prints exactly the format-spec §16.3 report at exit 0 and 1, and the envelope below (`command: "validate"`) at exit 2.
- **`--json` of every other command** is a versioned envelope:

  ```json
  {
    "outputVersion": 1,
    "command": "init",
    "ok": false,
    "result": null,
    "notices": [],
    "error": { "code": "already-a-library", "message": "…", "path": "/path/the/user/gave" }
  }
  ```

  - `command`: `init`, `validate`, `doctor`, `resolve-migration`, `migrate`, `config-show`, `config-set`, `config-unset`, `version`, or `null`. `ok` is `true` exactly when the exit code is 0. `result` is the object below, or `null`; partial work (`init` with `git-failed`) gives `result` and `error`. `notices` are `{ code, message }`, in order, plus `path` when about a folder.
  - `error`: `null`, or `{ code, message }` plus `argument` (usage errors), `path` (a refused folder), `file` and `field` (`config-error`), `issues` (format-spec §16.3 objects, sorted the same way) or `operation`, `file` and `errno` (`io-error`).
  - `outputVersion` changes only when a field is removed or changes meaning; agents ignore fields they do not know.
- **`result` per command:**
  - `version`: `{ version, supportedFormatVersion, node }`.
  - `init`: `{ libraryPath, libraryId, name, language, createdFolder, gitignore: "created" | "appended" | "unchanged", git: "initialized" | "already-initialized" | "not-requested", configLibraryPath: "set" | "kept" }`.
  - `config-show`: `{ configFile, exists, config }` (`{ "version": 1 }` without a file).
  - `config-set`: `{ configFile, key, value, media: null | { libraryId, marker: "written" | "kept" | "migrated" } }`.
  - `config-unset`: `{ configFile, key, wasSet }`.
  - `doctor`: `{ library: { path, source: "argument" | "current-folder" | "config" } | null, checks: [{ id, status, code, message, hint, details }], counts: { pass, info, warn, fail, skip } }`, in table order; `code`, `hint` and `details` are `null` when they do not apply.
  - `resolve-migration`: `{ backup: null | { state: "in-progress" | "done" | "no-manifest" | "unreadable-manifest", owner: null | { pid, host, claimedAt, alive }, ownerFile: "present" | "missing" | "unreadable", toVersion, restore, remove, taken, actions }, action: "none" | "restored" | "deleted" | "cancelled" }`, `alive` `null` for another host and `toVersion` `null` without a readable manifest.
  - `migrate`: `{ dryRun, status: "current" | "migrated" | "planned", libraryFormatVersion, versionsFound, toVersion, changed, added, removed }`, file lists library-relative and sorted.
- **Exit codes** (format-spec §16.1): **0** done or nothing to do; **1** problems found in the library or the setup (issues, a failed check, a refused migration); **2** it could not do what was asked. `internal-error` (a bug) shows in `--json` only the error's name and `errno` code ("Error (EACCES)"), never its message or stack.
- **Control characters never reach a terminal raw:** text output escapes control and invisible characters (`\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`) from a library, a media folder or a path as `\u` and four hex digits, or `\u{…}` above U+FFFF (§14); `--json` keeps values as they are.
- **Colors** only in text mode on a terminal, with `NO_COLOR` unset or empty and `TERM` not `dumb`; no `FORCE_COLOR` in M1.
- **Absolute paths** appear only for paths the user chose (given, the current folder, in the config, the config file) and folders found above them; files in a library or media folder are relative, with `/` (or `media:…`); the `validate` report never holds one.

#### Codes

Next to the codes below, the command line uses format-spec §16.2 codes (`media-folder-mismatch`, `newer-format`, `write-conflict`, `needs-migration`, `mixed-format-versions`, `media-marker-missing`, `leftover-temp-file`) unchanged; `not-a-library`, `unreadable-folder` and `io-error` come from `core` (§3).

| Code | Exit | Where | When |
| --- | --- | --- | --- |
| `unknown-command` | 2 | all | the command does not exist |
| `unknown-option` | 2 | all | an option the command does not have |
| `missing-argument` | 2 | all | no command, an option without its value, a required option or argument missing |
| `unexpected-argument` | 2 | all | an extra argument, a value for a flag, an option given twice |
| `invalid-argument` | 2 | all | a value breaks its rule |
| `node-too-old` | 2 | all; `doctor` | Node is older than `engines.node` |
| `internal-error` | 2 | all | an unexpected exception (a bug) |
| `no-library` | 2 | `validate`, `migrate`, `--resolve-migration` | no library given, found or configured |
| `not-a-library` | 2 | the same, `config set`; `doctor` | the folder has no `library.json` |
| `unreadable-folder` | 2 | `validate`, `migrate`, `--resolve-migration`; `doctor` | the library folder cannot be read |
| `library-json-invalid` | 2 | `config set mediaPath`; `doctor` | `library.json` has errors |
| `config-error` | 2 | commands that need the config; `doctor` | the config cannot be read, is invalid or cannot be written |
| `config-missing` | — | `doctor` | no config file yet |
| `library-path-not-set` | 2 | `config set mediaPath`; `doctor` | `libraryPath` is not set |
| `media-path-not-set` | — | `doctor` | `mediaPath` is not set |
| `already-a-library` | 2 | `init` | the folder has `library.json` |
| `inside-library` | 2 | `init` | a folder above has `library.json` |
| `inside-media-folder` | 2 | `init` | the folder or one above has `tastelib-media.json` |
| `library-files-present` | 2 | `init` | format files without `library.json` |
| `not-a-folder` | 2 | `init`, attaching; `doctor` | the path is not a folder |
| `parent-folder-missing` | 2 | `init`, attaching | neither the folder nor its parent exists |
| `gitignore-unusable` | 2 | `init` | `.gitignore` is not a regular UTF-8 file of at most 1 MiB |
| `git-not-found` | 2 | `init --git` | `git` cannot be started |
| `git-nested-repository` | 2 | `init --git` | the folder is inside another working tree |
| `git-failed` | 2 | `init --git` | `git init` failed (the library was created) |
| `media-inside-library` | 2 | attaching, `init`; `doctor` | the media folder is the library folder or inside it |
| `library-inside-media` | 2 | attaching; `doctor` | the library folder is inside the media folder |
| `media-inside-git` | 2 | attaching; `doctor` | the media folder is inside a Git working tree |
| `media-marker-unreadable` | 2 | attaching; `doctor` | the marker cannot be read or is invalid |
| `media-folder-not-empty` | 2 | attaching | not empty and no marker |
| `media-folder-missing` | — | `doctor` | `mediaPath` does not exist |
| `migration-backup-present` | 1 | `doctor`; `migrate --dry-run` | `.tastelib/migration-backup/` exists |
| `migration-blocked` | 1 | `migrate` | files with errors stop the migration |
| `not-interactive` | 2 | `--resolve-migration` | no terminal, or `--json`: nothing was done |
| `io-error` | 2 | commands that write | a read, write, flush, rename or removal failed |
| `gitignore-missing-tastelib` | — | `doctor` | `.gitignore` does not ignore `.tastelib/` |
| `library-not-in-git` | — | `doctor` | the library is not in a Git working tree |

Notices (exit 0): `suggest-git-init`, `in-git-working-tree`, `git-already-initialized`, `library-path-kept`, `media-folder-of-other-library`, `media-already-attached`, `migration-recovered`. In `doctor` the exit code follows the check's status (`—`: only there). A format-spec §16.2 code exits 1 in `validate` and `migrate`, 2 when attaching refuses the folder.

## 5. Capture

Capture happens on the computer, in the app, by pasting, dropping or choosing a file:

- **Screenshots and images**, stored compressed (WebP).
- **Page URLs**, captured as a full-page image by a headless browser, on the user's request only.
- **Videos and GIFs**, for motion; stored compressed, with frames extracted for pinning.

The reference records how it was captured in `source.via`: `paste`, `drop`, `file-picker` or `url-capture` (format-spec §7.1). New captures land in an **inbox** until processed.

**(to specify in M2)** size limits, compression settings, capture timeouts, frame extraction.

### No metadata in the media folder

Every media file the tool writes keeps no metadata from what the user pasted, dropped or chose: no EXIF (GPS location, device, owner, dates), XMP, IPTC, comments, text chunks, embedded thumbnail or video container metadata, also for a file kept without re-encoding. An embedded ICC profile is never copied, since it can carry text: the pixels are converted to sRGB, or the file carries only a standard sRGB or Display P3 profile the tool writes itself. #44 chooses how, and proves it with a test on generated files carrying each kind of metadata, a custom ICC profile with personal text among them. Media is synced and may be shared in packs (§10); a phone screenshot can say where the user lives (§14).

### Tall and wide captures

WebP stores at most 16383 pixels per side. A capture taller than that is split into **segments**, each a media item of the same reference, from the top (`m1` first); a wider one from the left. It stays format v1: a reference holds 1–50 media items (format-spec §7.1). #44 sets the segment size, any overlap, what happens past 50 segments and to an image over the limit on both sides (or the limit of another format it chooses).

- **`p0` on a split capture** (maintainer decision, 2026-11-05): consumers (the app, exports, agents) treat `p0` as covering every segment; the derived rule, confirmed by the maintainer, is that **`p0` covers every media item of the reference, in id order**, since v1 has no field that marks segments (format-spec §4.3, §7.4).
- **Pins** stay on one media item each (`mediaId`, format-spec §7.3). How the app shows segments together, and a box drawn across a seam, are decided with pins in M2.

### Adding media to a reference

The user can add media items to an existing reference by pasting, dropping or choosing a file in the reference view. Each takes the next number after `lastIssued.media`, never reused (format-spec §4.3); an added tall image is split like a new capture, the 50-item limit counts every item, and the metadata rule applies. `source` keeps the first capture. A URL capture always creates a new reference. Agents cannot add media (format-spec §13.1, `not-allowed`). When the `p0` interpretation is `to-review` or `accepted`, the app offers to reopen it right after media is added, as for a stale note; no `validate` code reports it (format-spec §13.4).

### File picker

The app's file chooser is the third way to bring in a local file, recorded as `source.via: "file-picker"`. The maintainer amended format v1 to add this value (2026-11-04, §18), the one exception to the frozen v1 (format-spec §7.1, §15.1).

### URL capture

- **Browsers** (maintainer decision): Chromium and Firefox are both supported. #45 chooses the engine, how each browser is obtained and found on each system, and the oldest versions supported. A browser is downloaded only by an explicit command the user runs (rule 5, confirmed 2026-11-05). A browser that the tool starts as a separate program, without bundling, copying or modifying it, is not a dependency under rule 7; the engine library that drives it is, and meets rule 7 (#45).
- **Network rules** (maintainer decision): every request a capture makes is refused when it goes to a loopback, private, link-local, shared (CGNAT), multicast or unspecified address, in IPv4 or IPv6, including redirects, subresources, WebSocket and WebRTC, checked on the address actually connected to (no DNS rebinding). #45 decides how, the same way in both browsers. Tests use an address policy that only test code can inject.
- So a page on the user's own computer or network (a development server, a router's page) is captured as a pasted screenshot instead (§14).

## 6. Notes and pins

- Each reference has a **free-text note** in the user's own words.
- **Pins** are boxes drawn on an area of an image or of a video frame. Each pin is a **piece** with its own note. The whole-reference note is a piece covering the whole reference.
- A pin is **positive** (take this) or **negative** (not this). Negative pins are the source of **guardrails**. There are no whole-image anti-references.
- Regions are stored as proportions (0–1) of the media size, so they survive resizing.
- The whole-reference note is piece `p0`; pins are `p1`, `p2`… A pin on a video sits on one of its extracted frames. Pieces are addressed across the library as `<ref-id>#p<n>`.
- A reference can hold several media items: the segments of a tall capture, and items added later (§5). `p0` covers every media item, in id order (§5 "Tall and wide captures"); each pin sits on one media item, which it names.
- The app stores notes exactly as typed; the only change is that line breaks are stored as `\n`. A note that breaks a rule (for example, a control character) is refused with a message, never silently altered.

## 7. Interpretation and review

- Interpretation runs in **batches through an agent** ("process my new references"). For each piece, the agent proposes vocabulary, keywords, screen types, components, design aspects and, for negative pins, a guardrail.
- Everything the agent writes is marked **`to-review`**. In the app, a review queue offers **Accept**, **Correct** or **Reject**. A correction is the user's complete version, stored next to the original proposal, which is never modified after review. Rejected proposals are kept, so agents see what the user refused and do not propose it again.
- The user's own words are never altered.
- Agent writes are an allowlist (format-spec §13.1): through `tastelib` (CLI or MCP), an agent can only add or replace proposals that are still `to-review` and set the links of an entry it created while it is still `to-review`. Everything else (references, media, pins, notes, names, user values, corrections, reviews, reopening, deleting, merging) is the user's, in the app, and refused with `not-allowed`.
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

**Translation layer.** A small in-house layer in `web`, no dependency (§18). Components never contain literal user-facing text. The first language comes from the browser preferences (the first `en` or `pt` tag decides, `pt-*` gives `pt-BR`, otherwise `en`), and a selector switches it at once. A missing key, an empty message or a placeholder that differs between languages fails `pnpm check`. The choice is stored in the per-machine config (§4) from M2.

The library's `language` (in `library.json`) is something else: the language of agent proposals, so the vocabulary stays in one language on every computer. Codes are English identifiers, and messages in `tastelib validate --json` and MCP results are always English; human-readable output may be translated. The command line is English only in M1 (§4 "Command line").

## 13. Portability

- Linux, Windows and macOS (Apple Silicon) are all first-class and verified in CI.
- No script that runs on only one operating system: Git hooks are POSIX `sh`, which Git runs everywhere, and helper scripts are plain Node.
- Text files use LF (`.gitattributes`); the tool reads either line ending.
- Library files are UTF-8 without a BOM, LF, in a canonical JSON form (format-spec §3), so the same data gives the same bytes on every system.
- File names inside a library and a media folder come only from identifiers (ASCII, lowercase, never a Windows reserved name), so they behave the same on case-insensitive file systems and never depend on Unicode normalization. Only the folders the user chooses may have non-ASCII names.
- Paths with non-ASCII characters (for example `Usuário`) are tested in CI. A path the user gave is stored verbatim, and a name from a directory listing is matched against a given one after `normalize("NFC")` on both, because macOS may return it in NFD.

## 14. Security

See [SECURITY.md](../SECURITY.md) for the sensitive surfaces. The local server listens on the loopback interface only and rejects cross-origin requests.

**Threat model.** The tool is used by one person, on their own computer, with their own account. This list says which conditions the tool must handle and which it need not. Reviews grade by it and by promises (introduction; `.claude/agents/reviewer.md`): a broken promise, contract or hard rule under a condition in scope is a blocker, as is a change to what users or agents see that the docs do not record; the same problem out of scope is minor. Code that differs from a description of mechanism is not a blocker: the fix is to remove the description.

- **In scope:**
  - **The user's own mistakes:** a hand-edited file with typos, wrong types, duplicate ids or broken links; a hand-resolved Git merge; a file deleted or moved by hand.
  - **Other computers:** files that arrive through `git pull` or a sync service, including older or newer format versions, and media that has not arrived yet.
  - **Interruptions:** a process that is killed, and a power cut during a write, within §4 "Writing library files", "Durability".
  - **Two `tastelib` writers at once** (the app and an agent), within the optimistic check of format-spec §5.
  - **The three platforms as people set them up:** Windows files held open by an antivirus, a sync client or an editor; macOS Unicode normalization and case-insensitive file systems; non-ASCII paths; links and junctions the user made to move the media folder or the whole library folder (§4 "Reading library files", "Links stay inside the library"); a drive that is not mounted; a folder the user cannot read.
  - **Untrusted content the tool consumes:** captured pages and URLs, briefings, media files, and a library cloned from someone else, with its links. It must not run code, lead a read or a write out of the library or the media folder (§4 "Reading library files", format-spec §6.2), make a write follow a link at a file path, exhaust memory past the limits of §4 "Reading library files", hang the tool, or put terminal control characters into its output.
  - **Agents,** which write only through `tastelib`, within the allowlist of format-spec §13.1.
- **Out of scope:**
  - **Someone who already controls the user's account** (or the administrator).
  - **Special files** (FIFOs, sockets, devices) the user's own account created at a library or media path; a link to one that arrives through Git or sync is in scope.
  - **Races with programs other than `tastelib`** between two system calls, beyond the windows format-spec §5 accepts.
  - **Storage that breaks its own guarantees:** a drive or file system that ignores `fsync`, reorders writes past it, or corrupts data at rest.
  - **Unusual permissions set on purpose** (a folder listable but not enterable): an error is reported, however many issues.
  - **Redundant issues and wording:** a second issue caused by a value that has its own, or a message that could be clearer. A problem not reported, or a wrong code or severity, is in scope.
  - **Mechanisms of later milestones,** designed by the issue that builds them.

Library and media paths are built only from identifiers. Validation reports never print absolute paths. The command line starts `git` only by an absolute path, never by name or from a folder it works on (§4 "`tastelib init`"). Media keeps no metadata from the user's files (§5 "No metadata in the media folder"). **URL capture reaches only the public internet** (§5 "URL capture"), so a captured page cannot reach the tool's own server or the local network, and the browser runs with a fresh temporary profile, away from the user's browsing data.

**(to specify in M2)**

## 15. Testing

- Unit tests sit next to the behavior; pure logic (schemas, parsers, naming, the intent filter, migrations) always has them. End-to-end tests (`pnpm test:e2e`) drive the app in a browser.
- Test data is **synthetic and generated at test time**; no third-party media and no binary fixture is ever committed.
- **Determinism:** fixed seeds and clocks, no real network, no dependence on listing order or locale.
- CI runs every check on Linux, Windows and macOS, under a non-ASCII path and with both line endings in inputs.
- **Required checks:** CI runs `tastelib validate --strict --checksums` on the golden v1 library with its media folder generated at test time, and fails on any error or warning; migrations are tested; a made-up briefing full of visual decisions must leak none of them into the intent, and the discarded list must show them all. The sample library (`examples/sample-library/`) joins this check in M7 (§16).
- The performance budget of §4 "Index" is a test in `pnpm test`, on every CI system.

### Format and migration tests

- **Golden libraries.** One hand-written, synthetic library per released format version, at `packages/core/test/golden/v<N>/`, frozen once released (only added to), with a media folder generated byte-stable at test time.
- **Schemas** have positive and negative tests for every rule in format-spec, including the canonical form and non-ASCII text in notes.
- **Each migration step N → N+1** is tested: the golden vN library migrates and validates at N+1; the step's changes; identical bytes on two runs; files already at N+1 pass through; an interrupted run, also of a mixed library, ends the same. **The chain:** every version has its schemas, its golden library and, above 1, its step, and the golden v1 library migrates through all of them.
- **Validate** has one test per issue code (format-spec §16.2), checking severity, file, pointer and exit code, on Linux, Windows and macOS and under a non-ASCII path.
- **Writes** have tests for every allowed agent write and refused kind (`not-allowed`), `write-conflict`, a multi-file write stopped partway (only `dangling-link` warnings remain), slugs, clock skew and ids never reused.

### Core test approach

- Test-only code (golden libraries, builders, a test-only format version 2 and its step, fault-injecting file systems) lives in `packages/core/test/`, never under `src/`. At version 1 the migration runner is tested through that step.
- **Crash points.** A write, deletion or migration stopped at any named step as by a crash leaves `validate` with no error (only `dangling-link` or `leftover-temp-file`), and running it again finishes it.
- **Runner failures.** Injected I/O errors and outside changes at each step check §4 "Migration runner failures".
- **Concurrency.** Orderings of two writers are tested deterministically in one process; real child processes show that exactly one of several claims a migration backup.

## 16. Release and publishing

- The repository is public since 2026-11-05, before the designed-UI milestone, and has been built as if public from the first commit (§18, the row on going public). Going public is not releasing: the license, the final name and 1.0 stay in M7.
- The public repository has private vulnerability reporting, secret scanning, Dependabot alerts, approval for outside workflows and the ruleset on `main`. The loop (`scripts/loop.mjs`) ignores issues without a milestone, comments by anyone but the maintainer, and pull requests from forks.
- Before the 1.0 release (M7): choose the license, choose the final name, write the README and install guide, ship a sample library with freely licensed media, test the MCP connector with another agent, release 1.0, and scan the repository again.
- Any publishing step goes through a release checklist issue: the agent shows it, explains each item and waits for the maintainer to confirm each one. Publishing runs in a separate workflow with a protected environment and manual approval.

## 17. Milestones

| Milestone | Delivers |
| --- | --- |
| M0 Foundation | monorepo, code standards, tests, CI on Linux, Windows and macOS, translations, `format-spec.md` v1, per-machine config, portability rules |
| M1 Core & format | schemas, validated read/write, index, migrations; `tastelib init / validate / doctor / config` (`migrate` with the first format v2 change, §18) |
| M2 Capture & notes | paste image, URL and video; compression; inbox; notes; positive and negative pins; awaiting sync; ends with a real-use checkpoint |
| M3 Agent kit I | writes through CLI and MCP; plugin with `/taste:process`; review queue |
| M4 Organization & taste | families, family pages, browsing, glossary, taste profile, comparison |
| M5 Project spaces | filtered intent, directions, pack export, image prompts, results loop; ends with a real-use checkpoint |
| M6 Designed UI | the tool's own interface, designed with its own method |
| M7 Release | see §16 |

## 18. Decision log

One row per live decision: the decision in at most two lines, the alternatives rejected in one, and the issue that holds the evidence. A superseded row is removed. **Maintainer** marks a maintainer decision.

| Date | Decision | Rejected | Issue |
| --- | --- | --- | --- |
| 2026-11-04 | A local app in the browser plus an agent kit (Claude Code plugin, MCP connector). | A desktop-only app; a hosted service. | #1 |
| 2026-11-04 | TypeScript throughout. | A second back-end language. | #1 |
| 2026-11-04 | Plain files are the source of truth; the index is disposable. | One SQLite file. | #1 |
| 2026-11-04 | The tool and personal libraries live in separate repositories; media lives outside Git. | One repository; media in Git or Git LFS. | #1 |
| 2026-11-04 | `docs/design.md` is the source of truth and holds this log; `docs/format-spec.md` is the data contract. | Separate ADR files. | #1 |
| 2026-11-04 | One issue, one branch, one squash-merged PR reviewed by a separate agent; one issue per session. | Direct commits to `main`; agent memory. | #1 |
| 2026-11-04 | The maintainer's own Git identity is allowed under "nothing personal". | A handle-only identity. | #1 |
| 2026-11-04 | Workflow helper scripts are plain Node (`.mjs`, no dependencies), tested with `node --test`. | Python; shell scripts. | #17 |
| 2026-11-04 | Node 26 LTS (at least 26.13.0), pnpm pinned by `packageManager`, TypeScript 6 ready for 7. | Node 24; Corepack; TypeScript 7 now. | #4 |
| 2026-11-04 | Biome for lint and format. | ESLint, Prettier and `typescript-eslint`. | #5 |
| 2026-11-04 | Packages build with `tsc -b`; bundling for distribution is decided in M7. | A bundler; a loader. | #4 |
| 2026-11-04 | Vitest in `pnpm check`, Playwright in `pnpm test:e2e`, a dev-only `testkit`, test images built by hand. | Jest; Playwright in `pnpm check`. | #6 |
| 2026-11-04 | Development-only, unmodified, unbundled MPL-2.0 dependencies are accepted (first: `lightningcss`). | A rule 7 that excludes Vite. | #6 |
| 2026-11-04 | Development-only BlueOak-1.0.0, CC0-1.0 and MIT-0 dependencies are accepted (first: `jsdom`). | No DOM environment renders React otherwise. | #10 |
| 2026-11-04 | Format v1 is frozen: every change is a new integer `formatVersion` with a tested migration. | A loose format until 1.0. | #8 |
| 2026-11-04 | **Maintainer:** v1 is amended once, adding `file-picker` to `source.via` (§5 "File picker"). | A v2 for one value. | #25 |
| 2026-11-04 | Strict schemas: every field present (`null` or `[]` when empty), unknown fields are errors. | Optional fields; an `extensions` object. | #8 |
| 2026-11-04 | Canonical JSON (format-spec §3); readers accept any layout and report `not-canonical`. | JSONC, JSON5, YAML. | #8 |
| 2026-11-04 | Readable identifiers (format-spec §4.3); numbers in a file are never reused; file names only from identifiers. | UUIDs; reused numbers. | #8 |
| 2026-11-04 | Slugs of families and projects are fixed at creation. | Slugs that follow the name. | #8 |
| 2026-11-04 | Timestamps are UTC with milliseconds; the interface shows local time. | Local offsets; epoch numbers. | #8 |
| 2026-11-04 | Interpretation is an `Authored<T>`: user `content`, or an agent's immutable `proposal` with a status and a `correction`. | Editing proposals in place. | #8 |
| 2026-11-04 | Proposals record a SHA-256 of their note; a changed note makes them stale. | No tracking; a copy of the note. | #8 |
| 2026-11-04 | A reference's state and families are derived, not stored. | Two-sided links. | #8 |
| 2026-11-04 | The taste profile is `taste-profile.json`, reviewed by statement. | `taste-profile.md`. | #8 |
| 2026-11-04 | A generated result is an ordinary reference with a `result` link. | A `results/` folder. | #8 |
| 2026-11-04 | The briefing is not stored; only the intent and the discarded list are. | Storing the briefing. | #8 |
| 2026-11-04 | The library holds no machine path; interface language and export folder are per machine. | Both in library files. | #8 |
| 2026-11-04 | Relative media paths with size and SHA-256; a marker ties the folder to its library; missing is awaiting sync. | Content-addressed names. | #8 |
| 2026-11-04 | Migrations are pure whole-library steps N → N+1, validated before any write, with a backup; no down-migrations. | Lazy per-file migration. | #8 |
| 2026-11-04 | Agent writes are an allowlist (format-spec §13.1). | A denylist. | #8 |
| 2026-11-04 | Concurrent writes use an optimistic byte check; a multi-file write writes the user's decision first. | A lock file; atomic multi-file writes. | #8 |
| 2026-11-04 | Duplicate keys are an error (`duplicate-key`). | The last value wins. | #8 |
| 2026-11-04 | The user's words are stored verbatim, line breaks as `\n`. | `\r\n` as typed. | #8 |
| 2026-11-04 | `--json` validation messages and MCP results are always English. | Translated messages. | #8 |
| 2026-11-04 | `validate`: three severities, stable codes, relative paths, exit 0, 1 or 2; a dangling link is a warning, refused when new. | Numeric codes; dangling links as errors. | #8 |
| 2026-11-04 | The per-machine config is a strict, versioned JSON file. | A loose schema. | #9 |
| 2026-11-04 | An original translation layer; React 19, Vite 8, `jsdom` for component tests. | `i18next`, `react-intl`. | #10 |
| 2026-11-04 | macOS runs in CI with Linux and Windows, on the runner named by `MACOS_RUNNER`. | macOS untested. | #19, #73 |
| 2026-11-04 | `core` has pure modules and `node/`, two entries, checked by a Biome rule. | A separate package. | #23 |
| 2026-11-04 | Validation problems are `Issue` values; other failures are results with their own codes; expected failures never throw. | Exceptions; new format codes. | #23 |
| 2026-11-04 | An original strict JSON reader, nesting limited to 64 levels. | `JSON.parse` with a scanner. | #23 |
| 2026-11-04 | One write pipeline in `core` sets timestamps, validates changes and new links, and rounds regions. | Values finished by callers. | #23 |
| 2026-11-04 | Every write flushes before its rename; Windows retries blocked renames and deletions. | No retry; `graceful-fs`. | #23 |
| 2026-11-04 | The index lives in memory, refreshed before every answer and write; a link into a broken file is unresolved. | A cache under `.tastelib/` (the first remedy); `fs.watch`. | #23 |
| 2026-11-04 | The migration runner is tested through a test-only v2 step passed in the format registry. | Waiting for a real v2. | #23 |
| 2026-11-04 | **Maintainer:** `git init` only with `--git`; media inside the library or a non-empty folder without marker refused; English CLI in M1; `--json`. | `git init` by default. | #24 |
| 2026-11-04 | The command checks Node first and parses arguments with `node:util` `parseArgs`. | `commander`, `yargs`. | #24 |
| 2026-11-04 | Library: the argument, the library around the current folder, then `libraryPath`; the config read only when needed. | `libraryPath` first. | #24 |
| 2026-11-04 | `init` requires `--name` and `--language`, writes `library.json` last and attaches no media; `git` by absolute path. | Defaults; `git` by name. | #24 |
| 2026-11-04 | `config set mediaPath` attaches first and writes only on success; a broken config is never overwritten. | Comparing path strings. | #24 |
| 2026-11-04 | `doctor` is read-only, keeps format-spec severities and exits 1 only on a failed check. | Repairing while checking. | #24 |
| 2026-11-04 | `migrate --dry-run` only reads; `--resolve-migration` acts only on a typed answer. | A `--yes` flag. | #24 |
| 2026-11-04 | One JSON document with `--json`: the report for `validate`, a versioned envelope otherwise; exit 0, 1, 2. | One envelope for `validate`. | #24 |
| 2026-11-04 | **Maintainer:** a browser started as a separate program is not a rule 7 dependency; the command that downloads one is part of URL capture. | Chromium only. | #25 |
| 2026-11-04 | **Maintainer:** URL capture refuses every request to a non-public address (§5 "URL capture"). | Allowing local addresses. | #25 |
| 2026-11-05 | **Maintainer:** `p0` covers every segment of a split capture; derived rule: every media item, in id order. | A format change. | #25 |
| 2026-11-05 | Media keeps no metadata and no custom ICC profile. | Removing GPS only. | #25 |
| 2026-11-05 | A capture over 16383 px is split into segments within v1's 50 media items. | Downscaling; cropping. | #25 |
| 2026-11-05 | The user can add media to a reference; agents cannot. | One media item per reference. | #25 |
| 2026-11-05 | `sharp` and `ffmpeg-static` are ruled out by rule 7 (LGPL and GPL at run time). | An LGPL linking exception. | #25 |
| 2026-11-05 | The required CI check validates the golden v1 library with generated media, `--strict --checksums`. | The sample library before M7. | #25 |
| 2026-11-05 | Deleting a reference deletes its file, then the links, then its media. | Links first. | #25 |
| 2026-11-05 | **Maintainer:** the repository is public from #73, with the ruleset on `main`. | Staying private. | #73 |
| 2026-11-05 | **Maintainer:** review findings are `blocker` or `minor` by §14; three rounds at most. | Every finding blocks. | #78 |
| 2026-11-05 | **Maintainer:** plans name the files they are `blockedBy`; re-running a deletion removes leftover links. | Refusing a re-run. | #35 |
| 2026-11-05 | One link-resolution rule serves the checks, the gate and the index. | Two that could drift. | #36 |
| 2026-11-05 | **Maintainer:** a budget line passes under its budget or within a bound over a same-run baseline. | Factors per platform. | #36 |
| 2026-11-05 | **Maintainer:** each budget line is timed three times and the fastest run is checked. | One timing; a retry. | #84 |
| 2026-11-05 | **Maintainer:** `CLAUDE.md` holds what every agent needs; the loop is the `continue` skill; plans stay in issues. | The loop in `CLAUDE.md`. | #85 |
| 2026-11-06 | Reads and writes stay inside the library; a link leading out, or into `.tastelib/` or `.git/`, is `unreadable-file`. | A new issue code. | #77 |
| 2026-11-06 | **Maintainer:** an older or mixed library is read through its in-memory migration; listing uses every supported layout. | Per-file migrated values. | #38 |
| 2026-11-06 | **Maintainer:** this document records promises and contracts, not mechanism, in at most 12,000 words; one row per live decision. | Behavior and contracts (#86). | #97 |
| 2026-11-06 | **Maintainer:** reviews grade by promises (introduction, §14). | Grading mechanism text. | #97 |
| 2026-11-06 | **Maintainer:** #39 and #43 wait for the first format v2 change; `doctor` reports a backup as present. | Recovery no v1 library needs. | #97 |
