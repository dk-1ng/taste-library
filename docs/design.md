# Design

This document is the source of truth for what taste-library does. Behavior is defined here before it is built, and a change to what users or agents see updates this document in the same pull request. The on-disk data format is specified separately in [format-spec.md](format-spec.md), the public contract that the tool, agents and integrations follow.

**Scope.** This document records what is visible from outside (the commands, their options, codes and outputs, the files the tool writes, and the public API of `core`) and the promises the tool keeps, in one or two sentences each. How the code keeps a promise (steps, order, timings, formulas, retries, internal checks) is not recorded here: the code and its tests are the record, with a doc comment where a reason would otherwise be lost. Plans live in the issues; the decision log (§18) holds one row per live decision, and the evidence lives in the issue or pull request it names.

**Reviews grade by promises** (§14 "Threat model"). A blocker is code that breaks a promise or a contract of this document or of format-spec, or a hard rule, under a condition in scope of §14; or a change to what users or agents see that the docs do not record. Code that differs from a description of mechanism is not a blocker: the fix is to remove the description.

**Size.** This document has at most 12,000 words: `pnpm docs:size` (`scripts/design-size.mjs`, part of `pnpm check`) fails above that. Raising the limit is a maintainer decision, recorded in §18.

Agents and people read this document by section, the headings first (`grep -n '^#' docs/design.md`), then the sections they need (`CLAUDE.md`, "Reading the docs").

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
  cli/      the `tastelib` command (init, validate, doctor, config; later migrate, open, process, export, ...)
  mcp/      MCP connector for any agent
  testkit/  dev-only test helpers: generated fixtures, non-ASCII temp directories
  e2e/      end-to-end tests (Playwright)
agent-kit/
  claude-code/   Claude Code plugin (commands and skills)
  AGENTS.md      the same instructions for other agents
docs/
examples/sample-library/   only the maintainer's own or freely licensed media
```

Planned building blocks (each confirmed or replaced when its milestone starts): React + Vite for the interface; Hono for the local server; zod for validation; a headless Chromium or Firefox for URL capture, driven by an engine that #45 chooses (§5 "URL capture"); image and video encoding chosen by #44, without `sharp` or `ffmpeg-static`, which rule 7 rules out (§18); Vitest and Playwright for tests; GitHub Actions on Linux, Windows and macOS.

### Toolchain and checks

The pinned tools and their versions are in the root `package.json` (`packageManager`, `engines`, `devDependencies`), `.nvmrc`, `pnpm-workspace.yaml` and each package's `package.json`; the compiler options in `tsconfig.base.json`; lint and format in `biome.json`; CI in `.github/workflows/`. Versions are exact, never ranges, and the lockfile is committed. Node is 26 LTS, at least 26.13.0.

- `pnpm check` is the single gate, run locally, by agents and in CI on Linux, Windows and macOS: lint, format check, the size of this document, typecheck, test and build. It stops at the first failure.
- Scripts in any `package.json` call only cross-platform programs; a step that needs more is a plain Node script.
- No dependency runs install scripts; one that needs it is listed in `allowBuilds` in `pnpm-workspace.yaml`, with the reason recorded in the same change.

### Packages and dependency graph

Every package is `@tastelib/<folder>`, `private`, with one `exports` entry (`e2e` and `web` have none; `core` has a second, `./browser`). The names are internal and can change with the final name (§16).

| Package | Depends on |
| --- | --- |
| `core` | nothing at run time (no other workspace package, ever); may list `testkit` as a `devDependency` |
| `server` | `core` |
| `mcp` | `core` |
| `cli` | `core`, `server` (`tastelib open` starts the server) |
| `testkit` | nothing |
| `e2e` | `testkit` (`devDependency`) |
| `web` | nothing yet; `react` and `react-dom` at run time (from M2 it uses `core` only through `@tastelib/core/browser`) |

The graph has no cycles. `agent-kit/` is not a workspace package and arrives in M3.

### Core modules and API

`core` has two entries. `@tastelib/core` is the Node entry and exports everything. `@tastelib/core/browser` exports pure modules only, which run unchanged in Node and in a browser. Pure modules import only `zod` and each other and use no Node-only global; code that touches the operating system lives in `packages/core/src/node/`. A Biome rule in `biome.json` checks this at the offending line; it is a lint rule, not a sandbox. Test-only code is never under `src/`, so it never reaches `dist/`. SHA-256 is passed to pure code by the caller, as a synchronous function.

**Public API for M2 and M3** (names are indicative; the shapes are the decision):

- `openLibrary(root, options)` reads every library file once and returns `{ ok: true, library }` or `{ ok: false, code, message }` with `code` `not-a-library` (no `library.json`) or `unreadable-folder`; the command line turns those into exit 2. Long-running processes (the M2 server, the M3 MCP connector) keep the `library` handle open.
- `library.snapshot()` returns an immutable **snapshot**, refreshed first (§4 "Index"): `formatVersion` (of `library.json`, or `null`), `files` (sorted by relative path; for each file its kind, its exact bytes, its fingerprint (`null` for a snapshot built in memory), its `formatVersion`, its status `valid`, `invalid`, `newer` or `unreadable`, its parsed value when valid, and its own issues, checked against the schemas of its own version), `migrated`, `issues` (the whole report, sorted as in format-spec §16.3) and `index`. When nothing changed, it returns the previous snapshot object itself.
- **The migrated view.** For an older or mixed library (format-spec §15.2) whose migration can run, `migrated` is a snapshot of the library as the migration would leave it, built in memory by the same steps as the migration on disk and `tastelib migrate --dry-run`: files at their migrated paths and current version, every fingerprint `null`. Otherwise `migrated` is `null`.
- **The report** is `reportOf(registry, snapshot, mediaIssues?)` (pure): the snapshot's issues plus the media issues, sorted and counted as in format-spec §16.3; without `mediaIssues` it adds `media-not-checked` once. When `migrated` exists, the cross-file issues come from it, at their migrated paths, with a message that says they were found after migration to version N. When the migration cannot run, the errors that block it are in the report, so the report has an error exactly when a write would refuse to migrate. A link into a file that is absent is `dangling-link`; a link into a file that is not `valid`, or under a folder that cannot be listed, is unresolved (§4 "Links to files with errors").
- `checkMedia(snapshot, mediaRoot, { checksums })` returns the media issues separately, so refreshing a snapshot never hashes media.
- `attachMediaFolder(library, path)` attaches a media folder (§4 "Attaching a media folder") and returns `attached` (with `marker` `written`, `kept` or `migrated`), `refused` (a stable code, message and issues) or `failed` (`io-error`). `guardMediaWrite(mediaFolder, libraryId)` is called before every media write: it refuses without a valid marker of this library, refuses a newer one (`newer-format`; the library stays writable) and migrates an older one on disk; `readMarker` reads it with the migration in memory only. `findGitWorkTree(path)` and `isInside(inner, outer)` give the Git working tree and the folder comparison of §4 "Comparing folders".
- `library.write(build, options)` runs a write (§4 "Writing library files"). `build` receives the fresh, gated snapshot and returns a **plan** `{ changes, skipped, blockedBy? }`: `changes` is an ordered list of `{ path, next }` (`next` `null` for a deletion), the first being the primary change (format-spec §5); `skipped` lists the files or unlistable folders the operation left alone, each `{ path, reason }`, passed through to the result; `blockedBy` lists files the plan depends on without changing them, and the write is refused with their issues when one is not `valid`. A plan that breaks its own shape is a bug and throws. The deletion planners (a pin, a reference, a family, a guardrail, a direction; pure, in both entries) build the plans of §4 "Deleting". Writes through one handle run one at a time, in order; across processes the optimistic check decides. The clock is an option.
- `library.migrate(options)` migrates on disk with no plan (§4 "`tastelib migrate`") and returns `current` (nothing written, not even `.tastelib/`), `migrated` (`from`, `to` and the files `changed`, `added` and `removed`, sorted by path), `refused` (`issues`) or `failed` (a `failure`), each with `notices`.
- **Issues** are plain data in the exact shape of format-spec §16.3: `{ severity, code, file, pointer, message }`, with `file` relative to the library with `/` (or `media:…`, or `null`). A code always has its format-spec §16.2 severity, also in a refusal.
- **Errors that are not validation issues** never become an `Issue`: they are results with their own stable codes, `not-a-library`, `unreadable-folder` and `io-error` (`{ code: "io-error", operation, file, errno, message }`, `file` relative to the library). Expected failures are never thrown; a thrown exception is a bug.
- **A write result** has a `status` and `notices`. The statuses are `written` (with the files written and `skipped`), `unchanged` (the plan changes nothing: nothing is written and no `updatedAt` moves), `refused` (`issues`: validation errors, a new `dangling-link`, `write-conflict`, `newer-format`, a migration that cannot run, later `not-allowed`) or `failed` (`io-error`, or `not-a-library` or `unreadable-folder` when the folder stopped being a readable library). `refused` and `failed` also list the files `written` and `notWritten`; both are non-empty only when a multi-file write stopped partway (format-spec §5). `notices` holds `{ code: "migrated", from, to }` exactly when the write migrated the library on disk, whatever the final status.

## 4. Library, media and configuration

- A **library** is a folder (usually its own private Git repository) holding the data files of [format-spec.md](format-spec.md).
- **Media** (images, full-page captures, videos, frames) lives in a separate **media folder**, outside any Git repository, which may be kept in sync by any file-sync service. Its marker (`tastelib-media.json`) holds the library's id, so attaching the wrong folder is detected. A media folder inside a Git working tree, inside the library folder or containing it, and a non-empty folder without a marker, are refused with no exception ("Attaching a media folder" below).
- Media that a library references but that has not arrived yet is shown as **awaiting sync**, never as an error.
- **Per-machine configuration** lives outside the library and is never committed: `~/.config/tastelib/config.json` on Linux and macOS (under `$XDG_CONFIG_HOME` when it is an absolute path), `%APPDATA%\tastelib\config.json` on Windows. The library holds no machine path.
- **The config file** is JSON with `version` (`1`) and the optional fields `libraryPath`, `mediaPath`, `packsExportPath` (absolute paths in the form of the operating system that reads the file, with no `.` or `..` segments) and `language` (`en` or `pt-BR`, §12). Unknown fields are refused; a missing file means `{ "version": 1 }`; a file over 1 MiB, or one that is not a regular file, is not read (a link to a regular file is followed). Every error, including a failed write, is a `ConfigError` naming the file and, when there is one, the field. It is written atomically, never when invalid, and a `mediaPath` inside a Git working tree is refused.
- **Every write** goes through `tastelib`, is validated first and replaces files atomically; concurrent writers and writes of several files follow format-spec §5 (`write-conflict`, the user's decision first, the files written reported). There is no lock file.
- **Timestamps** are UTC; a writer sets `updatedAt` and `reviewedAt` to the later of now and their lower bound (format-spec §4.1), so a skewed clock never makes a write fail.
- **Format versions.** Read-only commands migrate an older library in memory only. Before its first write to an older or mixed library, `tastelib` migrates it on disk and says so (the `migrated` notice), validating everything first, keeping a backup in `.tastelib/migration-backup/` until it finishes and writing `library.json` last (format-spec §15.3). While a backup exists every write is refused with `write-conflict`: recovery (#39), `tastelib migrate` and `tastelib doctor --resolve-migration` (#43) wait for the first format v2 change (§18). The backup must never be deleted by hand or by `git clean -X` (format-spec §5). No down-migrations; Git history is the way back. The media marker has its own version, migrated on disk when the folder is next attached or written to, in memory only by read-only commands.
- **Deleting** a pin, a reference, a family, a guardrail or a direction writes the primary change first (the pin and its interpretation removed; the reference or family file deleted; the guardrail or direction entry removed, its file kept even when empty; `lastIssued` kept), then removes every link to it (format-spec §14), one file at a time in path order; a family link in a direction and a direction link in a `result` become `null`. A removed link moves the `updatedAt` of what held it and edits no `Authored` value (format-spec §4.6). Running a deletion again completes it: only leftover links are removed, and with none the result is `unchanged`.
- **Deleting a reference** then deletes its media folder through the media write guard (format-spec §6.1). A stop partway leaves at worst `dangling-link` and `orphan-media` warnings. A media folder that is not attached, or not synced yet, does not block it; a folder that turns up later is `orphan-media`.

### Reading library files

- **Every rule reports once:** a malformed value is reported by its own rule, and the rules across fields (duplicate ids, local links, kind against type, `updatedAt` against `createdAt`, `lastIssued`) still run on the rest (format-spec §16.2). Exception: a list over its maximum (for example 501 pins) stops the rules of the objects above it.
- **Links stay inside the library.** Until this is built (#92), the reader follows every link; the rest of this bullet and §14 state the behavior once built. Every file the tool reads or writes in a library, and every folder it lists or creates there, is the library's real folder or lies under it once symbolic links and junctions are resolved; the library folder itself may be a link.
  - A file that leads outside is `unreadable-file` ("a symbolic link or junction that leads outside the library") and is never opened. A format folder that leads outside cannot be listed: `unreadable-file` on the folder, everything under it unresolved. A link that resolves into the library's own `.tastelib/` or `.git/` counts as leading outside. Messages never say where a link leads. `library.json` follows the same rule, also when a command looks for its library.
  - A `.tastelib/` that leads outside refuses every write with `unreadable-file` at `.tastelib`.
  - Other links that stay inside are followed. A write never follows a link at a file path: the rename replaces the link and a deletion removes it.
  - **Setups that are not supported:** a format folder or file moved elsewhere through a link (for example `references/` on another drive). Move the whole library folder, or make the library folder itself the link.
- **I/O.** Over 8 MiB is `file-too-large`, not parsed (format-spec §3.2); a read error, or a path that is not a regular file, is `unreadable-file`, and a link to a FIFO or `/dev/zero` never hangs the reader. A file that disappears between the listing and the read is treated as deleted. Results are ordered by path.
- **The strict reader** is an original RFC 8259 parser that never recurses. Invalid UTF-8 is `invalid-encoding` (pointer `null`), a lone surrogate `invalid-encoding` at its pointer, a repeated key (compared after decoding) `duplicate-key` at that key; each of these is reported, and the first syntax error stops the reader with `invalid-json` (pointer `null`, line and column in the message). A key named `__proto__` is an ordinary unknown field.
  - **Nesting is limited to 64 levels** of objects and arrays: deeper input is `invalid-json` ("nested deeper than 64 levels"), never thrown. RFC 8259 §9 allows the limit, so this is still plain JSON.
- **Which files are listed.** The format folders are listed with the layouts of every supported version (format-spec §15.2), so a file at a path only an older version has is read and migrated, never ignored; a file at a path its own version's layout lacks is `schema-violation` at `/formatVersion` and blocks a migration.
- **Validation.** A file with any error is `invalid`; its value is not used by the index or by other files' checks.

### Writing library files

`library.write` writes the plan or ends with a result (§3); nothing of the plan reaches the disk before every check has passed. The write gate (below) runs first, and only its migration writes before the plan exists.

- **Plan.** A plan may not replace or delete a file that is not `valid`, nor depend on one through `blockedBy`: the write is refused with that file's issues, because only the user repairs a file with errors. A change under a folder that could not be listed is refused with that folder's `unreadable-file` issue.
- **Authorize** (M3): agent writes outside the allowlist (format-spec §13.1) give `not-allowed`.
- **Validation.** One invalid change refuses the whole plan, with the issues of every invalid file. A new link (one the same entry, or the same field of the same file, did not have) must resolve as the whole plan leaves the library, otherwise the write is refused with `dangling-link` (severity `warning`); so is a new link into a file that is not `valid`. Links already dangling are kept. Warnings (`proposal-stale`, `duplicate-term`) do not block.
- **Timestamps.** The write sets every `updatedAt`: a file or entry that changed gets the later of now and its `createdAt`; a new file, entry or pin gets `createdAt` and `updatedAt` equal to now; `createdAt` never changes; reviews set `reviewedAt` to the later of now and `proposedAt`. A plan that changes nothing ends `unchanged` and writes nothing. One write gives all its files the same time.
- **Replace.** Files are written canonically (format-spec §3.3) in plan order, the primary change first, each through a temporary file `.<name>.tmp-<8 Crockford characters>` in the same folder. Every target is checked against its snapshot bytes and the migration backup before the first rename (`write-conflict`, nothing written) and again just before its own; a write that stops at a file lists the files before it in `written` and the rest in `notWritten`. Format folders are created when first needed and removed again when the write ends `refused` or `failed`.
- **Proportions.** Regions are rounded per axis to integer millionths, only after validation (a negative width is still refused): a valid region never becomes invalid, a tiny size never becomes 0, rounding is idempotent, a region with at most 6 decimals is never changed, and no value moves by more than 1e-6.
- **Durability.** Every write flushes its temporary file before the rename, on every platform, so a power cut leaves the previous file or the new one, never an empty one. A flush that fails after the rename ends the write `failed`, with the file counted as written. A library folder that is gone fails the write as `openLibrary` does (`unreadable-folder`, or `not-a-library`).
- **Links on the way to a file.** A target whose folder is outside the library, or inside its `.tastelib/` or `.git/`, fails with `io-error` (operation `realpath`, `EINVAL`) before anything is touched. A link at the target itself is replaced, never followed.
- **Windows renames and deletions.** On Windows a rename or deletion failing with `EPERM`, `EACCES` or `EBUSY` (a file held open by an antivirus, a sync client or an editor) is retried for up to 2 seconds, rechecking the target each time, then fails with `io-error`. A temporary file that cannot be deleted stays: `leftover-temp-file` in a format folder, the `temp-files` check of `tastelib doctor` at the top level. Linux and macOS do not retry.
- **Cleanup only on result paths.** A write that ends `refused` or `failed` leaves no temporary file or created folder (except as just said); a process that dies, or a bug that throws, leaves the disk as it was at that moment.

### Write gate

Before the plan is built, every write:

1. **Refreshes** the snapshot (§4 "Index").
2. **Checks the migration backup:** a `.tastelib/` that leads outside refuses with `unreadable-file` at `.tastelib`; while `.tastelib/migration-backup/` exists, the write is refused with `write-conflict` and the backup is kept.
3. **Checks `library.json`:** missing (or the folder unreadable), the write ends `failed` with `not-a-library` (or `unreadable-folder`); not `valid`, it is `refused` with its issues.
4. **Refuses newer files**, with one `newer-format` issue per file (format-spec §15.1).
5. **Migrates an older or mixed library** on disk, then goes on with the notice `{ code: "migrated", from, to }`, kept whatever happens to the plan: `to` is the current version, `from` the version of `library.json`, or the lowest version present when `library.json` is already current. A migration that cannot run writes nothing and the write is `refused` with the blocking files' issues. At version 1 no library is older or mixed.

Writes to the media folder have their own guard on the marker (format-spec §6.1).

### Migration runner failures

A file changed outside `tastelib` during a migration stops it with `write-conflict` naming the file. A migration that fails after it created its backup cleans up before it returns: the library is as it was (or migrated, with the `migrated` notice, if it got that far), the backup is gone, and the write ends `failed` (`io-error`) or `refused` (`write-conflict`); a file it had not reached is never touched. If the cleanup fails too, the backup stays; a long-running process finishes its own cleanup before its next write, provided neither the backup nor the files changed meanwhile.

### Links to files with errors

A cross-file link resolves if its target file is `valid` and holds the target, and is dangling if the file is absent or `valid` without the target. A link into a file that is not `valid`, or under a folder that could not be listed, is **unresolved**: no `dangling-link` (the broken file has its own error), it counts for nothing in the index, a write that adds it is refused, and link removal after a deletion skips that file and lists it in `skipped` (`{ path, reason: "invalid" | "unreadable" | "newer" }`; a folder that could not be listed is `unreadable`), so an unrelated broken file never blocks the user's decision. When the file that holds the thing being deleted is not `valid`, or under such a folder, the deletion is refused with its issues (`blockedBy`).

### Index

The index is derived data, kept **in memory only**, inside the snapshot; nothing is cached under `.tastelib/`.

- **What it holds** (M2–M4): references with their pieces, derived state (format-spec §7.7) and `result` link; each piece's families, from effective values (`to-review` gives a tentative family); which targets exist; and backlinks, every `(file, pointer)` linking to each target, dangling and unresolved ones included. In an older or mixed library it is built from the migrated view (§3); without one, only files valid at the current version count.
- **How it is built.** An updated index always equals a fresh rebuild from the same files, and the checks, the gate and the index resolve links by one rule, so they never disagree.
- **Freshness.** Before every answer and every write, a refresh lists the format folders and checks every file's metadata, re-reading what changed. No change is missed, including a second one within the file system's timestamp resolution (2 seconds on FAT). No `fs.watch` in M1; the M2 server may use it only as a hint.
- **Performance budget**, a test on Linux, Windows and macOS CI, on a library generated with a fixed seed: 5000 references (1–2 media items, 0–5 pins, about 60% of pieces interpreted, about 3.4 KB per file), 50 families of 100 members, 300 glossary terms and one project, about 17 MB: opening it **under 5 seconds**; a refresh with nothing changed, and with one reference changed, **under 0.5 seconds** each; one single-file write, gate and flush included, **under 1 second**. On a CI runner a line also passes within `factor × baseline + overhead` over a plain baseline timed in the same run (read and `JSON.parse`; a `stat` scan; that plus one durable write), with the constants named in the test and the same on every system. **Three runs:** each line and baseline is timed three times and the fastest is checked (§18). If the budget fails, the first remedy is a disposable cache under `.tastelib/`.

### Command line

`tastelib` (`packages/cli`) is the command people and agents run. M1 delivers `init`, `validate`, `doctor` and `config`; `migrate` and `doctor --resolve-migration` arrive with the first format v2 change (#43, §18); `open` (M2), the agent writes (M3) and `export` (M5) follow under the same rules. The command line only parses, calls `core` and prints. The report of `validate` is format-spec §16; the rest of this section is the command line's own contract, under the maintainer decisions of §18 (`git init` only with `--git`; refused media folders with no exception; English text in M1; stable codes; `--json` everywhere).

#### Building and running

- The command is the `bin` of `packages/cli` (`tastelib` → `dist/bin.js`). It checks the Node version against `engines.node` (26.13.0, the same in `packages/cli/package.json` as at the root) before loading anything else: an older Node gets `node-too-old`, never a syntax error.
- It never cuts off its own output, and an `EPIPE` on standard output ends it quietly. `--version` prints the version of the `cli` package.
- Before any release, run `pnpm build`, then `pnpm tastelib <arguments>` from the repository root (relative paths resolve from there) or `node <repository>/packages/cli/dist/bin.js <arguments>`. `tastelib` on `PATH` is decided in M7.

#### Arguments

- Usage errors exit 2 (format-spec §16.1) with a message of ours ending "Run `tastelib <command> --help`.": an option the command does not have is `unknown-option`; no command, an option without its value, or a required option or argument missing is `missing-argument`; an extra positional argument, a value given to a flag (`--json=1`) or an option given twice is `unexpected-argument`; a value that breaks its rule (a name, a language tag, a config key) is `invalid-argument`, naming the argument.
- A value that starts with `-` is written `--name=-value` (`--name -value` is `missing-argument`); `--` ends the options.
- `--help` or `-h` prints text help and exits 0, whatever else is on the line, `--json` included; `tastelib --help` lists the commands. `tastelib` alone prints a usage on standard error (`missing-argument`, exit 2); an unknown command is `unknown-command` (exit 2). No negative flags, no short forms but `-h`.
- A path argument is resolved against the current folder by its text, links kept as given; a path stored in the config is that string, never resolved further or Unicode-normalized (§13).

#### Which library a command uses

`validate`, `doctor`, `migrate` and `doctor --resolve-migration` use, in this order:

1. The `<library>` argument, which must be a library folder itself (`not-a-library`).
2. The current folder or the nearest folder above it with a `library.json`, on the real path. A `library.json` is passed over only when it parses into a JSON object without an `id` matching `LibraryId` (format-spec §4.3); any other one (damaged, unreadable, too large, a link leading outside) stops the search, so `validate` reports its errors.
3. `libraryPath` from the config (`not-a-library`, naming the field and the config file).
4. Otherwise `no-library` (exit 2).

`doctor` never stops on these: its `library-path` and `library` checks report them. The text output names the library and where it came from (argument, current folder or `libraryPath`), with no absolute path the user did not type; `validate --json` at exit 0 and 1 stays exactly the format-spec §16.3 report.

**The media folder** of a command is `--media <folder>` (only `validate` has it), otherwise `mediaPath`, but only when the library in use is the configured `libraryPath`; otherwise none, and `validate` reports `media-not-checked`.

**The config is read only when a command needs a value from it**, so `tastelib validate <folder> --media <folder>` runs with a broken config. A needed value that cannot be read is `config-error` (exit 2); `doctor` reports it as a check.

#### `tastelib init`

`tastelib init [<folder>] --name <name> --language <tag> [--git] [--json]`

- `<folder>` defaults to the current folder; a missing one is created only when its parent exists.
- `--name` (required) is the user's words, stored exactly as given; one that is not a `Name` (format-spec §4.2) is `invalid-argument`, naming the rule it breaks.
- `--language` (required, no default) is the `LanguageTag` of agent proposals (format-spec §5.1); a bad tag is `invalid-argument`.

**Refusals,** in this order, before anything is written (exit 2, nothing changed): `not-a-folder`, `parent-folder-missing`, `already-a-library`, `inside-library`, `inside-media-folder`, `library-files-present`, `gitignore-unusable`, `config-error`, `media-inside-library` (the configured `mediaPath` is in the folder), then with `--git` `git-nested-repository` and `git-not-found`.

**What it writes:** the folder when missing; `.gitignore`, created with `# Working area of taste-library, never committed` and `.tastelib/`, or given the line `.tastelib/` (in the file's line ending) when no line already ignores the folder; then, last, `library.json` with a new `LibraryId`, the name, the language and `createdAt`, so running `init` again after a failure works (another `init` that won meanwhile gives `already-a-library`). A new library passes `tastelib validate --strict` (only `media-not-checked`).

**Git.** Without `--git`, `init` never runs `git` and adds the notice `suggest-git-init` (no working tree) or `in-git-working-tree` (inside another repository's). With `--git`: `.git` already in the folder gives the notice `git-already-initialized`; a working tree above is `git-nested-repository`; `git` is found by absolute path in the absolute entries of `PATH` only (a regular file, executable on Linux and macOS; `git.exe` on Windows), never by name and never in the current or the library folder (§14), else `git-not-found`. `git init` runs after the files are written; its failure is `git-failed` (exit 2; the library exists). `init` never commits.

**The config.** `init` sets `libraryPath` when it is unset; otherwise it keeps it, with the notice `library-path-kept`. When it sets `libraryPath` while `mediaPath` is set, the notice `media-folder-of-other-library` says that folder belongs to another library. A failed config write is `config-error`, saying the library was created. `init` attaches no media folder. Order after the checks: files, `git init`, config, notices.

#### `tastelib config`

`tastelib config [show] [--json]` · `tastelib config set <key> <value> [--json]` · `tastelib config unset <key> [--json]`

- **`show`** (the default) prints the config file's path, whether it exists, and every field; it never creates anything.
- **`set`** accepts `libraryPath` and `mediaPath` in M1 (`language` with M2, `packsExportPath` with M5); **`unset`** accepts all four and never touches a folder or a marker. Another key is `invalid-argument`. A config that cannot be read or is invalid is never overwritten (`config-error`).
- **`set libraryPath <folder>`** needs a library (`not-a-library`); when `mediaPath` holds another library's marker, the notice `media-folder-of-other-library` says so. `mediaPath` never changes implicitly.
- **`set mediaPath <folder>`** attaches the folder to the library at `libraryPath` (`library-path-not-set`; `not-a-library`, `library-json-invalid` or `newer-format` for that library) and writes `mediaPath` only when attaching succeeds.

#### Attaching a media folder

`attachMediaFolder` in `core` is the only code that attaches a folder. Its checks, in order; the first that fails refuses (exit 2) and writes nothing:

1. `not-a-folder`: not a folder, or a link to a folder that does not exist.
2. `media-inside-library`: the library folder or a folder inside it.
3. `library-inside-media`: a folder that contains the library folder.
4. `media-inside-git`: inside a Git working tree.
5. The marker `tastelib-media.json`: unreadable or invalid is `media-marker-unreadable` (its issues at `media:tastelib-media.json`); another library's is `media-folder-mismatch`; a newer one is `newer-format`; this library's is attached again (an older marker migrated on disk), with the notice `media-already-attached`.
6. `media-folder-not-empty`: not empty ("Empty" below) and no marker.
7. `parent-folder-missing`.

Then the folder is created when missing and the marker `{ "formatVersion": 1, "libraryId": "<id>" }` is written canonically and atomically; a marker that changed meanwhile is `write-conflict` (also from `guardMediaWrite`). An I/O failure is `io-error`, `file` being `media:tastelib-media.json`, `media:` (the folder) or `library:`.

**Comparing folders.** "Inside" and "the same folder" are decided on real folders by file-system identity, once links, junctions and mapped drives are resolved, so case, Unicode normalization and Windows short names never matter; without an identity, real paths are compared after `normalize("NFC")`, case-insensitively on Windows and macOS. The Git check looks for `.git` on the same real path.

**Empty.** A folder is empty when every entry has one of these names (compared after `normalize("NFC")` and `toLowerCase()`): `.DS_Store`, `.localized`, `Icon\r`, `desktop.ini`, `Thumbs.db`, `.directory`, `.dropbox`, `.dropbox.attr`, `.dropbox.cache`, `.stfolder`, `System Volume Information`, `$RECYCLE.BIN`, `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `.TemporaryItems`, and `.tastelib-media.json.tmp-<8 Crockford characters>`. The list is closed: any other entry, an empty subfolder or a link included, makes it not empty. A media folder that lost its marker is therefore refused: attach an empty folder and move the reference folders into it.

#### `tastelib doctor`

`tastelib doctor [<library>] [--json]` checks this computer's setup and writes nothing: no config, folder or marker, no migration, no `git`.

Each check has a stable `id`, a `status` (`pass`, `info`, `warn`, `fail` or `skip`), a `code` (not for `pass` or `skip`), a `message` and, unless it passes, a `hint`. A check that reports a format-spec §16.2 code takes that code's severity (error `fail`, warning `warn`, info `info`). A check whose input is unknown is `skip`, with the reason; `media-outside-library` and `media-marker` run only when the library in use is `libraryPath`. In this order:

| Check | Results |
| --- | --- |
| `node` | `pass`; `fail` `node-too-old` |
| `config` | `pass`; `warn` `config-missing`; `fail` `config-error` |
| `library-path` | `pass`; `warn` `library-path-not-set`; `fail` `not-a-library`, `unreadable-folder`; `skip` when the config fails |
| `library` (the library in use, and its source) | `pass`; `fail` `not-a-library`, `unreadable-folder`; `skip` when there is none |
| `library-format` | `pass`; `info` `needs-migration`; `warn` `mixed-format-versions`; `fail` `library-json-invalid` (with its issues), `newer-format` |
| `migration-backup` | `pass`; `fail` `migration-backup-present` (writes are refused while it exists; never delete it by hand) |
| `temp-files` (top of the library, format folders, top of the media folder, the config folder's `.config-<hex>.tmp`) | `pass`; `warn` `leftover-temp-file`, with the files |
| `gitignore` | `pass`; `warn` `gitignore-missing-tastelib` |
| `git` | `pass`; `warn` `library-not-in-git` |
| `media-path` | `pass`; `warn` `media-path-not-set`; `fail` `media-folder-missing`, `not-a-folder`; `skip` when the config fails |
| `media-outside-git` | `pass`; `fail` `media-inside-git` |
| `media-outside-library` | `pass`; `fail` `media-inside-library`, `library-inside-media` |
| `media-marker` (an older marker passes) | `pass`; `warn` `media-marker-missing`; `fail` `media-folder-mismatch`, `media-marker-unreadable`, `newer-format` |

**Exit code:** 0 when no check fails, 1 when one does, 2 when `doctor` cannot run (bad arguments).

#### `tastelib migrate`

`tastelib migrate [<library>] [--dry-run] [--json]` migrates on request (format-spec §15.2), from #43. Without `--dry-run` it runs `library.migrate`: a current library gives "Nothing to migrate" and writes nothing, not even `.tastelib/` (exit 0); a migration prints a summary and one line per file (`changed`, `added` or `removed`, sorted by path; exit 0); a refusal is `migration-blocked` (with the issues), `newer-format` or `write-conflict` (exit 1); a failure is `io-error` (exit 2). Once recovery exists (#39), a recovery that ran first is the notice `migration-recovered`. `--dry-run` only reads, writes nothing, and lists `would change`, `would add` and `would remove`; a migration backup gives no plan but `migration-backup-present` (exit 1).

#### `tastelib doctor --resolve-migration`

`tastelib doctor --resolve-migration [<library>] [--json]`, from #43, shows a migration backup (state, owner and claim time, the files a restore would put back and remove) and offers **restore** (only when the manifest is `in-progress` or unreadable), **delete** and **cancel**, warning first that a restore overwrites files changed since the interruption. It acts only on the full word typed in a terminal (standard input and output, no `--json`); anything else cancels (exit 0). Without a terminal it shows the backup and exits 2 with `not-interactive`; no flag acts without the prompt. A backup that changed while the user decided is `write-conflict` (exit 1); an I/O failure is `io-error` (exit 2), and running the command again finishes it.

#### Output

- **Streams.** Text results go to standard output, errors to standard error. With `--json`, standard output receives exactly one JSON document and an LF, whatever the exit code, and standard error stays empty.
- **Language.** English in M1; a later pt-BR command line (§12) keeps codes, `--json` messages and option names in English.
- **Codes.** Every error and notice has a stable kebab-case code ("Codes" below), part of the contract; messages are not. Text output shows `error <code>: <message>` or `note <code>: <message>`, then `hint: …` when there is one.
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

  - `command`: `init`, `validate`, `doctor`, `resolve-migration`, `migrate`, `config-show`, `config-set`, `config-unset`, `version`, or `null` for a missing or unknown command. `ok` is `true` exactly when the exit code is 0.
  - `result`: the command's object below, or `null` when it did nothing; partial work before an error (`init` with `git-failed`) gives both `result` and `error`.
  - `notices`: `{ code, message }` in the order they happened, plus `path` when about a folder.
  - `error`: `null`, or `{ code, message }` plus `argument` (usage errors), `path` (a refused folder), `file` and `field` (`config-error`), `issues` (format-spec §16.3 objects, sorted the same way) or `operation`, `file` and `errno` (`io-error`).
  - `outputVersion` changes only when a field is removed or changes meaning; agents ignore fields they do not know.
- **`result` per command:**
  - `version`: `{ version, supportedFormatVersion, node }`.
  - `init`: `{ libraryPath, libraryId, name, language, createdFolder, gitignore: "created" | "appended" | "unchanged", git: "initialized" | "already-initialized" | "not-requested", configLibraryPath: "set" | "kept" }`.
  - `config-show`: `{ configFile, exists, config }` (`{ "version": 1 }` without a file).
  - `config-set`: `{ configFile, key, value, media: null | { libraryId, marker: "written" | "kept" | "migrated" } }`.
  - `config-unset`: `{ configFile, key, wasSet }`.
  - `doctor`: `{ library: { path, source: "argument" | "current-folder" | "config" } | null, checks: [{ id, status, code, message, hint, details }], counts: { pass, info, warn, fail, skip } }`, in table order; `code`, `hint` and `details` are `null` when they do not apply.
  - `resolve-migration`: `{ backup: null | { state, owner: null | { pid, host, claimedAt, alive }, ownerFile: "present" | "missing" | "unreadable", toVersion, restore, remove, taken, actions }, action: "none" | "restored" | "deleted" | "cancelled" }`, `alive` `null` for another host and `toVersion` `null` without a readable manifest.
  - `migrate`: `{ dryRun, status: "current" | "migrated" | "planned", libraryFormatVersion, versionsFound, toVersion, changed, added, removed }`, file lists library-relative and sorted.
- **Exit codes**, extending format-spec §16.1: **0** done or nothing to do (a cancelled prompt included); **1** the command ran and found problems in the library or the setup (issues, a failed check, a refused migration); **2** it could not do what was asked. An unexpected exception is `internal-error` (exit 2); in `--json` its message holds only the error's name and `errno` code (for example "Error (EACCES)"), never its message or stack, which text mode prints to standard error.
- **Control characters never reach a terminal raw:** text output escapes every control or invisible character (`\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`) of text that can come from a library, a media folder or a path, as `\u` and four hexadecimal digits, or `\u{…}` above U+FFFF (§14). `--json` keeps values as they are.
- **Colors** only in text mode on a terminal, with `NO_COLOR` unset or empty and `TERM` not `dumb`; no `FORCE_COLOR` in M1. The text says everything without them.
- **Absolute paths** appear only for paths the user chose (given, the current folder, stored in the config, the config file) and folders found above them; files in a library or media folder are always relative, with `/` (or `media:…`), and the `validate` report never holds one (§14).

#### Codes

The command line's codes. It also uses format-spec §16.2 codes (`media-folder-mismatch`, `newer-format`, `write-conflict`, `needs-migration`, `mixed-format-versions`, `media-marker-missing`, `leftover-temp-file`) with their meaning and severity; `not-a-library`, `unreadable-folder` and `io-error` come from `core` (§3).

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

Notices (exit 0): `suggest-git-init`, `in-git-working-tree`, `git-already-initialized`, `library-path-kept` (`init`); `media-folder-of-other-library` (`config set`, `init`); `media-already-attached` (`config set`); `migration-recovered` (`migrate`). In `doctor` the exit code follows the check's status; `—` means the code appears only there. A format-spec §16.2 code exits 1 in `validate` and `migrate`, and 2 when attaching refuses the folder.

## 5. Capture

Capture happens on the computer, in the app, by pasting, dropping or choosing a file:

- **Screenshots and images**, stored compressed (WebP).
- **Page URLs**, captured as a full-page image by a headless browser, on the user's request only.
- **Videos and GIFs**, for motion; stored compressed, with frames extracted for pinning.

The reference records how it was captured in `source.via`: `paste`, `drop`, `file-picker` (a file chosen with the app's file chooser) or `url-capture` (format-spec §7.1; see "File picker" below).

New captures land in an **inbox** until processed.

**(to specify in M2)** size limits, compression settings, capture timeouts, frame extraction.

### No metadata in the media folder

Every media file that the tool writes to the media folder keeps no metadata from what the user pasted, dropped or chose: no EXIF (which can hold the GPS location, the camera or phone, the owner's name and the date), no XMP, no IPTC, no comments or text chunks, no embedded thumbnail, and for videos no container metadata (creation time, location, device). Only the pixels (and, for video, the frames and timing) reach the media folder. Re-encoding drops most of it on its own; whatever path #44 chooses, including a file kept without re-encoding (for example one already small enough), must remove it too, so a pasted file is never copied into the media folder with its metadata. An embedded ICC color profile from the user's file is never copied either, because a custom profile can carry text (its description, copyright and device fields): either the pixels are converted to sRGB and no profile is written, or the file carries only a known standard profile (the exact bytes of a standard sRGB or Display P3 profile) that the tool writes itself. #44 chooses between the two. #44 also decides how metadata is removed and adds a test that proves it on generated files carrying each kind of metadata: EXIF with a GPS location, XMP, IPTC, comments and text chunks, an embedded thumbnail, video container metadata, and a custom ICC profile with personal text in it. URL captures come from the browser's own screenshot, so they carry nothing from the user's files; the same rule still applies to what the encoder writes.

The reason: media is synced and may be shared in packs (§10), while the user pasted it only for how it looks. A screenshot from a phone, or a photo of a screen, can say where the user lives; that must never leave the computer by accident (§14).

### Tall and wide captures

WebP stores at most 16383 pixels on each side. An image or page capture taller than that (a long full page, a tall screenshot) is split into several **segments**, each its own media item of the same reference, in order from the top (`m1` is the top segment, then `m2`, …); a capture wider than the limit is split the same way from the left. It stays format v1: a reference holds 1–50 media items (format-spec §7.1), and a segment is an ordinary media item of kind `image` or `page`. If #44 chooses a format with another limit, the split follows that format's limit. #44 sets the segment size, whether segments overlap, what happens past 50 segments (for example, downscale or refuse) and what happens to an image over the limit on both sides.

- **`p0` on a split capture.** format-spec §7.4 as written in M0 said that `p0` covers "the whole first media item", which for a split capture is only its top segment.
  - *Maintainer decision (2026-11-05):* the format stays v1, and consumers (the app, exports, agents reading files) treat `p0` as covering **every segment of a split capture**: the app shows the whole-reference note against all of them, and an export's whole-image view of `p0` (§10) shows every segment, in order.
  - *Derived rule (maintainer confirmed, 2026-11-05):* format v1 has no field that marks which media items are segments of one capture, so the only rule consumers can apply to v1 data without guessing is that **`p0` covers every media item of the reference, in id order**. For a reference with one media item this is exactly format-spec §7.4; for a split capture it is every segment; it also covers media the user adds later (below), which the decision itself does not settle. If the maintainer wants segments only, consumers need a field that marks them, which is a format change the decision rejected.
  - format-spec §4.3 and §7.4 say the same; no schema, field or validation rule changed.
- **Pins** stay on one media item each (`mediaId`, format-spec §7.3), so a pin lies within one segment. How the app shows segments together and what it does with a box drawn across a seam is decided with pins in M2.

### Adding media to a reference

The user can add media items to an existing reference (another screenshot of the same screen, a video of its motion), by pasting, dropping or choosing a file in the reference view. Each new item takes the next number: `lastIssued.media` plus one, then `lastIssued.media` is raised (format-spec §4.3); a number is never reused, even after its item is removed. An added tall image is split into segments like a new capture (above), and the 50-item limit counts every item of the reference. The same metadata rule applies. `source` keeps recording how the reference was first captured and is not changed by adding media. A URL capture always creates a new reference, because `source.url` names one page. Agents cannot add media: format-spec §13.1 reserves media to the user, and `tastelib` refuses it with `not-allowed`.

Because `p0` covers every media item (the derived rule above, confirmed by the maintainer), adding media changes what `p0` covers. When the reference's `p0` interpretation is `to-review` or `accepted` (the states `proposal-stale` covers, format-spec §13.4), the app offers, right after the media is added, to reopen it, as it does for a stale note: the interpretation was made without the new media. No `validate` code reports it and nothing is stored to remember it, because format-spec §13.4 limits staleness to the note in v1.

### File picker

The app's file chooser is the third way to bring in a local file, next to paste and drop, and the reference records it as `source.via: "file-picker"`. Format v1 as written in M0 allows only `paste`, `drop` and `url-capture`. The maintainer decided (2026-11-04) to **amend format v1** to add `file-picker`, instead of making it format v2, because no tool had written a v1 file yet (§18). This reverses the "v1 is frozen" decision of §18 for this one value only; every other change still needs a new format version. format-spec §7.1 holds the value and §15.1 records the amendment, and the golden v1 library holds a reference with it.

### URL capture

- **Browsers** (maintainer decision, 2026-11-04): Chromium and Firefox are both supported. #45 chooses the engine (one that drives both, or one per browser), how each browser is obtained and found on Linux, Windows and macOS, and the oldest versions supported. A browser is downloaded only by an explicit command the user runs, never on its own (rule 5); that this command counts as part of the URL capture the user asks for, and so is allowed by rule 5, awaits the maintainer's confirmation (§18).
- **Firefox and rule 7** (maintainer decision, 2026-11-04): Firefox is MPL-2.0. A browser that the tool starts as a separate program, installed by the user or by that explicit command, and that is not bundled, copied or modified by the tool, is accepted under rule 7. The tool links no browser code; it only talks to the browser over its control protocol. The same reading covers Chromium. The engine library that drives the browsers is an ordinary dependency and must meet rule 7 itself (#45).
- **Network rules** (maintainer decision, 2026-11-04): every request a capture makes, not only the URL the user gave, is refused when it goes to a loopback, private, link-local, shared (CGNAT), multicast or unspecified address, in IPv4 or IPv6. That includes redirects, subresources, WebSocket and WebRTC, and the address actually connected to is checked, so DNS rebinding does not get around it. #45 decides how, the same way in both browsers. Tests capture pages from a loopback test server through an address policy that only test code can inject, never reachable from the config, the API or the command line (#45).
- **Consequence:** a page served from the user's own computer or local network (a development server on `localhost`, a router's page) cannot be captured by URL. It is captured as a screenshot and pasted instead. The reasons are in §14.

## 6. Notes and pins

- Each reference has a **free-text note** in the user's own words.
- **Pins** are boxes drawn on an area of an image or of a video frame. Each pin is a **piece** with its own note. The whole-reference note counts as a piece covering the whole reference: every segment of a split capture, and every media item under the derived rule of §5 "Tall and wide captures".
- A pin is **positive** (take this) or **negative** (not this). Negative pins are the source of **guardrails**. There are no whole-image anti-references.
- Regions are stored as proportions (0–1) of the media size, so they survive resizing.
- The whole-reference note is piece `p0`; pins are `p1`, `p2`… A pin on a video sits on one of its extracted frames. Pieces are addressed across the library as `<ref-id>#p<n>`.
- A reference can hold several media items: the segments of a tall capture, and items the user added later (§5). `p0` covers every segment of a split capture (maintainer decision) and, under the derived rule confirmed by the maintainer, every media item of the reference, in id order (§5 "Tall and wide captures"); each pin sits on one media item, which it names.
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

**Translation layer.** A small in-house layer in `web`, no dependency (§18); its files are described in its code. Components never contain literal user-facing text. The first language is taken from the browser preferences (the first `en` or `pt` tag decides, and `pt-*` gives `pt-BR`; otherwise `en`) and a selector switches it at once. A missing key, an empty message or a placeholder that differs between languages fails `pnpm check`. Storing the choice in the per-machine config (§4) arrives with the server.

The interface language is a per-machine setting (§4). The library's `language` (in `library.json`) is something else: the language in which agents write proposals, so the vocabulary stays in one language whichever computer the library is opened on. Validation codes are stable identifiers in English. Messages in `tastelib validate --json` and in MCP results are always in English, so agents and scripts see the same text everywhere; the human-readable output may be translated into the interface language. In M1 the command line's text output is English only too (maintainer decision); a pt-BR command line comes later (§4 "Command line", "Output").

## 13. Portability

- Linux, Windows and macOS (Apple Silicon) are all first-class and verified in CI.
- No script that runs on only one operating system. Git hooks are POSIX `sh`, which Git runs on every platform. Workflow helper scripts are plain Node (`.mjs`, no build step, no dependencies), which runs on every platform.
- Text files use LF (`.gitattributes`); the tool reads either line ending.
- Library files are UTF-8 without a BOM, LF, in a canonical JSON form (format-spec §3), so the same data gives the same bytes on every system.
- File names inside a library and a media folder come only from identifiers (ASCII, lowercase, never a Windows reserved name), so they behave the same on case-insensitive file systems and never depend on Unicode normalization. Only the folders the user chooses may have non-ASCII names.
- Paths with non-ASCII characters (for example `Usuário`) are tested in CI. macOS file systems may return such a name in a different Unicode normalization (NFD) than the one passed in, so a path the user gave is stored verbatim, and when a name from a directory listing is matched against a given one, both are compared after `normalize("NFC")`; equality of the raw strings is never assumed.

## 14. Security

See [SECURITY.md](../SECURITY.md) for the sensitive surfaces. The local server listens on the loopback interface only and rejects cross-origin requests.

**Threat model.** The tool is used by one person, on their own computer, with their own account. This list says which conditions the tool must handle and which it need not. A review grades its findings by it and by promises (the `continue` skill, step 6; the full list is in `.claude/agents/reviewer.md`): code that breaks a promise or a contract of this document or of format-spec, or a hard rule, under a condition in scope, is a blocker, and so is a change to what users or agents see that the docs do not record; the same problem under a condition out of scope is minor. Code that differs from a description of mechanism is not a blocker: the fix is to remove the description.

- **In scope:**
  - **The user's own mistakes:** a hand-edited file with typos, wrong types, duplicate ids or broken links; a hand-resolved Git merge; a file deleted or moved by hand.
  - **Other computers:** files that arrive through `git pull` or a sync service, including older or newer format versions, and media that has not arrived yet.
  - **Interruptions:** a process that is killed, and a power cut during a write, within §4 "Writing library files", "Durability".
  - **Two `tastelib` writers at once** (the app and an agent), within the optimistic check of format-spec §5.
  - **The three platforms as people set them up:** Windows files held open by an antivirus, a sync client or an editor; macOS Unicode normalization and case-insensitive file systems; non-ASCII paths; links and junctions the user made to move the media folder or the whole library folder (§4 "Reading library files", "Links stay inside the library"); a drive that is not mounted; a folder the user cannot read.
  - **Untrusted content the tool consumes:** captured pages and URLs, briefings, media files, and a library cloned from someone else, with the links it carries. Such input must not run code, make a read or a write leave the library folder or the media folder (format-spec §6.2; §4 "Links stay inside the library"), make a write follow a link at a file path, exhaust memory past the limits of §4 "Reading library files", hang the tool (a link to `/dev/zero` is `unreadable-file`), or put terminal control characters into its output. A library cloned on Windows without symbolic links gets each link as a small text file, treated as any other file of that name.
  - **Agents,** which write only through `tastelib`, within the allowlist of format-spec §13.1.
- **Out of scope:**
  - **Someone who already controls the user's account** (or the administrator).
  - **Special files** (FIFOs, sockets, devices) that the user's own account created at a library or media path; Git and sync services carry only regular files and links. A link that arrives that way and leads to a special file is in scope.
  - **Races with programs other than `tastelib`** between two system calls, beyond the windows format-spec §5 accepts.
  - **Storage that breaks its own guarantees:** a drive or file system that ignores `fsync`, reorders writes past it, or corrupts data at rest.
  - **Unusual permissions set on purpose** (a folder that can be listed but not entered): the tool reports an error, but how many issues is not a requirement.
  - **Redundant issues and wording:** a second issue caused by a value that already has its own, or a message that could be clearer while it still names the field and what is expected. A problem not reported at all, or a wrong code or severity, is in scope.
  - **Mechanisms of later milestones,** whose failure modes are designed by the issue that builds them.

Library and media paths are built only from identifiers that match the format's patterns. Validation reports name files relative to the library and never print absolute paths. The command line starts external programs (only `git`, for `tastelib init --git`) by an absolute path from the absolute entries of `PATH`, never by name and never from the current folder or a folder it works on (§4 "Command line").

**Personal data in media.** Media files keep no metadata from the user's files, so a pasted screenshot never carries where or on what device it was taken into the media folder, a sync service or a pack (§5 "No metadata in the media folder").

**URL capture reaches only the public internet.** A captured page is untrusted content running in a real browser. Every request it makes to a loopback, private, link-local, shared, multicast or unspecified address is refused (§5 "URL capture"), so a page cannot reach the tool's own server, a development server, a router or other local devices. The browser runs with a fresh temporary profile, so a capture never sees the user's browsing data.

**(to specify in M2)**

## 15. Testing

- Unit tests sit next to the behavior; pure logic (schemas, parsers, naming, the intent filter, migrations) always has them. End-to-end tests drive the app in a browser; they run in `pnpm test:e2e`, not in `pnpm check`.
- Test data is **synthetic and generated at test time**. No third-party images, pages or videos are ever committed, and no binary fixture at all: images are generated at run time.
- **Determinism:** fixed seeds and clocks, no real network (local test servers only), no dependence on directory listing order or locale.
- CI runs every check on Linux, Windows and macOS, including a non-ASCII path and both line endings in inputs.
- **Required checks:** CI runs `tastelib validate --strict --checksums` on the golden v1 library with its media folder generated at test time, and fails on any error or warning; migrations are tested; a made-up briefing full of visual decisions must leak none of them into the intent, and the discarded list must show them all. The sample library (`examples/sample-library/`) joins this check in M7 (§16).
- The performance budget of §4 "Index" is a test in `pnpm test`, on every CI system.

### Format and migration tests

- **Golden libraries.** `packages/core` keeps one hand-written, synthetic library per released format version, at `packages/core/test/golden/v<N>/`, frozen once its version is released: never edited, only added to. Its media folder is generated at test time, byte for byte the same on every system, so its recorded sizes and checksums always match.
- **Schemas** have positive and negative tests for every rule in format-spec, including the canonical form and non-ASCII text in notes.
- **Each migration step N → N+1** is tested: the golden vN library migrates to a library that validates at N+1; the step's own changes; two runs give identical bytes; files already at N+1 pass through; an interrupted run is recovered and reaches the same result; a library with mixed versions too. **The chain:** every version up to the current one has its schemas, its golden library and, above 1, its step, and the golden v1 library migrates through every step and validates.
- **Validate** has one test per issue code (format-spec §16.2), checking severity, file, pointer and exit code, on Linux, Windows and macOS and under a non-ASCII path.
- **Writes** have tests for every allowed agent write and every refused kind (`not-allowed`, format-spec §13.1), for `write-conflict`, for a multi-file write that stops partway (the primary change is kept, only `dangling-link` warnings remain, and the result lists the files written and not written), for slugs, for clock skew, and for sequential ids never reused.

### Core test approach

- Test-only code (the golden libraries, builders, a test-only format version 2 with its migration step, fault-injecting file systems) lives in `packages/core/test/`, never under `src/`, so it can never reach `dist/`. At version 1 the migration runner is tested through that test-only step, passed in through the format registry.
- **Crash points.** A test can stop a write, a deletion or a migration at each of its named steps as a crash would; afterwards `validate` reports no error (only `dangling-link`, or `leftover-temp-file` after a crash inside a replace), and running the operation again finishes it.
- **Runner failures.** Injected I/O errors and outside changes at each step of a migration show its promises of §4 "Migration runner failures".
- **Concurrency.** Orderings of two writers or migrations are tested deterministically in one process; real child processes show what only the operating system can: that exactly one of several processes claims a migration backup.

## 16. Release and publishing

- The repository is public since 2026-11-05, before the designed-UI milestone, and has been built as if public from the first commit (§18, the row on going public). Going public is not releasing: the license, the final name and 1.0 stay in M7.
- The public repository has private vulnerability reporting, secret scanning, Dependabot alerts, approval for outside workflows and the ruleset on `main`. The loop (`scripts/loop.mjs`) ignores issues without a milestone, comments by anyone but the maintainer, and pull requests from forks.
- Before the 1.0 release (M7): choose the license, choose the final name, write the README and install guide, ship a sample library with freely licensed media, test the MCP connector with another agent, release 1.0, and scan the repository again.
- Any publishing step goes through a release checklist issue: the agent shows it, explains each item and waits for the maintainer to confirm each one. Publishing runs in a separate workflow with a protected environment and manual approval.

## 17. Milestones

| Milestone | Delivers |
| --- | --- |
| M0 Foundation | monorepo, code standards, tests, CI on Linux, Windows and macOS, translations, `format-spec.md` v1, per-machine config, portability rules |
| M1 Core & format | schemas, validated read/write, index, migrations; `tastelib init / validate / doctor / migrate / config` |
| M2 Capture & notes | paste image, URL and video; compression; inbox; notes; positive and negative pins; awaiting sync; ends with a real-use checkpoint |
| M3 Agent kit I | writes through CLI and MCP; plugin with `/taste:process`; review queue |
| M4 Organization & taste | families, family pages, browsing, glossary, taste profile, comparison |
| M5 Project spaces | filtered intent, directions, pack export, image prompts, results loop; ends with a real-use checkpoint |
| M6 Designed UI | the tool's own interface, designed with its own method |
| M7 Release | see §16 |

## 18. Decision log

One row per live decision: the decision in at most two lines, the alternatives rejected in one, and the issue where the evidence lives. A superseded row is removed; Git history keeps it.

| Date | Decision | Rejected | Issue |
| --- | --- | --- | --- |
| 2026-11-04 | A local app in the browser plus an agent kit (Claude Code plugin, MCP connector). | A desktop-only app; a hosted service. | #1 |
| 2026-11-04 | TypeScript throughout. | A Python, Go or Rust back end: two languages. | #1 |
| 2026-11-04 | Plain files are the source of truth; the index is disposable. | One SQLite file: opaque to agents and Git diffs. | #1 |
| 2026-11-04 | The tool and personal libraries live in separate repositories; media lives outside Git. | One repository; media in Git or Git LFS. | #1 |
| 2026-11-04 | `docs/design.md` is the source of truth and holds this log; `docs/format-spec.md` is the data contract. | Separate ADR files. | #1 |
| 2026-11-04 | One issue, one branch, one squash-merged PR reviewed by a separate agent; one issue per session. | Direct commits to `main`; an agent's memory of earlier sessions. | #1 |
| 2026-11-04 | The maintainer's own Git identity is allowed under "nothing personal". | A handle-only identity. | #1 |
| 2026-11-04 | Workflow helper scripts are plain Node (`.mjs`, no dependencies), tested with `node --test` in `pnpm check`. | Python; shell scripts. | #17 |
| 2026-11-04 | Node 26 LTS (at least 26.13.0), pnpm pinned by `packageManager`, TypeScript 6 configured to build unchanged on 7. | Node 24; Corepack; TypeScript 7 before its API and linters. | #4 |
| 2026-11-04 | Biome for lint and format. | ESLint, Prettier and `typescript-eslint`. | #5 |
| 2026-11-04 | Packages build with `tsc -b` and project references; bundling for distribution is decided in M7. | A bundler; running sources through a loader. | #4 |
| 2026-11-04 | Vitest in `pnpm check`, Playwright in `pnpm test:e2e`, a dev-only `testkit`, test images built by hand. | Jest; Playwright in `pnpm check`; an image library. | #6 |
| 2026-11-04 | Development-only, unmodified, unbundled MPL-2.0 dependencies are accepted (first: `lightningcss`). | A strict rule 7 that excludes Vite and Vitest. | #6 |
| 2026-11-04 | Development-only BlueOak-1.0.0, CC0-1.0 and MIT-0 dependencies are accepted (first: `jsdom`); only the maintainer widens rule 7. | A DOM environment limited to MIT, ISC, BSD and Apache-2.0: none found. | #10 |
| 2026-11-04 | Format v1 is frozen: every later change is a new integer `formatVersion` with a tested migration. | A loose format until 1.0; major and minor versions. | #8 |
| 2026-11-04 | **Maintainer decision:** v1 is amended once, to add `file-picker` to `source.via` (§5 "File picker"). | A format v2 for one value; recording a chosen file as `drop`. | #25 |
| 2026-11-04 | Strict schemas: every field present (`null` or `[]` when empty), unknown fields are errors, no extension field. | Ignoring unknown fields; an `extensions` object; optional fields. | #8 |
| 2026-11-04 | Canonical JSON (format-spec §3); readers accept any layout and report `not-canonical`. | JSONC, JSON5, YAML, front matter; insertion-ordered lists. | #8 |
| 2026-11-04 | Readable identifiers (format-spec §4.3); sequential numbers inside a file are never reused (`lastIssued`); file names only from identifiers. | UUIDs; global numbers; reused numbers; names from user text. | #8 |
| 2026-11-04 | Slugs of families and projects are fixed at creation; renaming changes the name only. | Slugs that follow the name. | #8 |
| 2026-11-04 | Timestamps are UTC with milliseconds and `Z`; the interface shows local time. | Local offsets; epoch numbers. | #8 |
| 2026-11-04 | Interpretation is an `Authored<T>`: the user's `content`, or an agent's immutable `proposal` with a status and a complete `correction`; review has Reject. | Editing proposals in place; partial corrections; deleting rejected proposals. | #8 |
| 2026-11-04 | Proposals record a SHA-256 of their note; a changed note makes them stale (a warning). | No tracking; a copy of the note. | #8 |
| 2026-11-04 | Derived, not stored: a reference's state and its families; guardrail proposals live only in `guardrails.json`. | Stored state and two-sided links. | #8 |
| 2026-11-04 | The taste profile is `taste-profile.json`, reviewed statement by statement; its Markdown is rendered on demand. | `taste-profile.md`. | #8 |
| 2026-11-04 | A generated result is an ordinary reference with a `result` link. | A `results/` folder with its own schema. | #8 |
| 2026-11-04 | The briefing is not stored; only the intent and the discarded list are. | Storing the briefing. | #8 |
| 2026-11-04 | The library holds no machine path; the interface language and the export folder are per-machine settings. | Interface language in `library.json`; export path in `project.json`. | #8 |
| 2026-11-04 | Media paths are relative with size and SHA-256 (format-spec §6); a marker ties the folder to its library; a missing file is awaiting sync. | Content-addressed names; absolute paths; a mismatch as an error. | #8 |
| 2026-11-04 | Migrations are pure whole-library steps N → N+1, validated in memory before any write, with a backup until done; the marker has its own version; no down-migrations. | Lazy per-file migration; per-file steps; down-migrations. | #8 |
| 2026-11-04 | Agent writes are an allowlist (format-spec §13.1); everything else is `not-allowed`. | A denylist of protected fields. | #8 |
| 2026-11-04 | Concurrent writes use an optimistic byte check (`write-conflict`); a multi-file write writes the user's decision first and reports partial results. | Atomic multi-file writes; a lock file; comparing `updatedAt`. | #8 |
| 2026-11-04 | Duplicate keys are an error (`duplicate-key`). | The last value wins. | #8 |
| 2026-11-04 | The user's words are stored verbatim, except that line breaks are stored as `\n`. | `\r\n` as typed; refusing `\r`. | #8 |
| 2026-11-04 | `--json` validation messages and MCP results are always in English; a library-wide issue has `file: null`. | Translated messages; a made-up file name. | #8 |
| 2026-11-04 | `validate`: three severities, stable codes, relative paths, exit 0, 1 or 2; a cross-file dangling link is a warning, refused when new. | Errors only; numeric codes; absolute paths; dangling links as errors. | #8 |
| 2026-11-04 | The per-machine config is a strict, versioned JSON file; a `mediaPath` inside a Git working tree is refused when written. | A loose schema; checking only in `doctor`. | #9 |
| 2026-11-04 | An original translation layer (typed catalogs, a React context); React 19 and Vite 8; `jsdom` for component tests. | `i18next`, `react-intl`, `lingui`. | #10 |
| 2026-11-04 | macOS runs in CI with Linux and Windows, on the runner named by `MACOS_RUNNER`. | macOS as "expected to work". | #19, #73 |
| 2026-11-04 | `core` has pure modules and `node/`, with two entries checked by a Biome rule; SHA-256 is passed in. | A test that scans imports; a separate package. | #23 |
| 2026-11-04 | Validation problems are `Issue` values; other failures are results with their own codes; expected failures never throw. | A new format-spec §16.2 code; exceptions. | #23 |
| 2026-11-04 | An original strict JSON reader: duplicate keys and lone surrogates with pointers, nesting limited to 64 levels. | `JSON.parse` with a scanner; recursion; no depth limit. | #23 |
| 2026-11-04 | One write pipeline in `core` sets timestamps, validates every change and new link, never overwrites a file with errors, and rounds regions. | Finished values from callers; operations setting `updatedAt`. | #23 |
| 2026-11-04 | Every write flushes the file before its rename; on Windows a rename or deletion blocked by another program is retried. | Flushing only for recovery; no retry; `graceful-fs`. | #23 |
| 2026-11-04 | The index lives in memory, refreshed before every answer and write, without `fs.watch`; a link into a file with errors is unresolved. | A cache under `.tastelib/` (the first remedy); `fs.watch`; such links as dangling. | #23 |
| 2026-11-04 | The migration runner is tested with a test-only v2 step injected through the format registry, never from `src/`. | Waiting for a real v2; a test step in `src/`. | #23 |
| 2026-11-04 | **Maintainer decisions:** `init` runs `git init` only with `--git`; media inside the library, or a non-empty folder without a marker, is refused; English CLI in M1, stable codes, `--json`. | `git init` by default; any folder as media; a translated CLI in M1. | #24 |
| 2026-11-04 | The command checks the Node version first; arguments are parsed with `node:util` `parseArgs` and the command's own checks. | `commander`, `yargs`, `cac`; Node's own error messages. | #24 |
| 2026-11-04 | A command uses the argument, then the library around the current folder, then `libraryPath`; `mediaPath` only for that library; the config only when needed. | `libraryPath` first; no upward search. | #24 |
| 2026-11-04 | `init` requires `--name` and `--language`, writes `library.json` last, sets `libraryPath` only when unset, attaches no media; `git` by absolute path. | Defaults; `library.json` first; `git` by name. | #24 |
| 2026-11-04 | `config set mediaPath` attaches through `attachMediaFolder` and writes only on success; a broken config is never overwritten; "empty" is a closed list. | Path-string comparison; ignoring every hidden file. | #24 |
| 2026-11-04 | `doctor` is read-only; a check reporting a format-spec code takes its severity; exit 1 only when a check fails. | Repairing while checking; failing on warnings. | #24 |
| 2026-11-04 | `migrate --dry-run` only reads; `--resolve-migration` acts only on a typed answer in a terminal. | A `--yes` flag; single-letter answers. | #24 |
| 2026-11-04 | Output: one JSON document with `--json` (the report for `validate`, an envelope otherwise), help as text, exit 0, 1, 2, absolute paths only as chosen. | One envelope for `validate`; text only; exit 1 for refused folders. | #24 |
| 2026-11-04 | **Maintainer decision:** a browser started as a separate program, not bundled, copied or modified, is not a rule 7 dependency; the command that downloads one is part of URL capture (confirmed 2026-11-05). | Treating it as bundled; bundling one; Chromium only. | #25 |
| 2026-11-04 | **Maintainer decision:** URL capture supports Chromium and Firefox and refuses every request to a non-public address (§5 "URL capture"). | Allowing local addresses; checking only the given URL. | #25 |
| 2026-11-05 | **Maintainer decision:** `p0` covers every segment of a split capture; derived rule (confirmed): every media item of the reference, in id order. | A format change; the first item only; detecting segments. | #25 |
| 2026-11-05 | Media keeps no metadata and no custom ICC profile from the user's files. | Keeping metadata; removing GPS only. | #25 |
| 2026-11-05 | A capture over WebP's 16383 px is split into segments within v1's 50 media items. | Downscaling; cropping; PNG; a new format version. | #25 |
| 2026-11-05 | The user can add media to a reference; agents cannot; the app offers to reopen an interpreted `p0`. | One media item per reference; a new `validate` warning. | #25 |
| 2026-11-05 | `sharp` and `ffmpeg-static` are ruled out by rule 7 (LGPL and GPL at run time); #44 and #45 choose. | An LGPL dynamic-linking reading. | #25 |
| 2026-11-05 | The required CI check is `tastelib validate --strict --checksums` on the golden v1 library with generated media. | The sample library before M7; committed golden media. | #25 |
| 2026-11-05 | Deleting a reference deletes its file first, then the links to its pieces, then its media folder, which may be absent. | Links first; media first. | #25 |
| 2026-11-05 | **Maintainer decision:** the repository is public from #73, with the ruleset on `main`; macOS stays in every PR's CI. | Staying private; macOS on some PRs only. | #73 |
| 2026-11-05 | **Maintainer decision:** reviews grade findings `blocker` or `minor` by §14; a re-review checks the delta; three rounds at most. | Every finding blocks; rounds without severity. | #78 |
| 2026-11-05 | **Maintainer decisions:** a plan may name the files it is `blockedBy`; re-running a deletion removes only leftover links; one clock reading per write. | Skipping a broken holder; refusing a re-run. | #35 |
| 2026-11-05 | One link-resolution rule and one version summary serve the checks, the gate and the index. | Two implementations that could drift. | #36 |
| 2026-11-05 | **Maintainer decision:** a budget line passes under its absolute budget or within a bound over a baseline from the same run; the budget test runs alone. | The absolute budget alone; factors per platform. | #36 |
| 2026-11-05 | **Maintainer decision:** each budget line and baseline is timed three times and the fastest run is checked. | One timing; the median; a retry. | #84 |
| 2026-11-05 | **Maintainer decisions:** `CLAUDE.md` keeps what every agent needs, the loop is the `continue` skill, docs are read by section, plans stay out of the docs. | The loop in `CLAUDE.md`; a plan section here. | #85 |
| 2026-11-06 | Reads and writes stay inside the library: a file or format folder whose link leads outside, or into `.tastelib/` or `.git/`, is `unreadable-file`. | Documenting the risk; a new issue code. | #77 |
| 2026-11-06 | **Maintainer decisions:** an older or mixed library is read through the in-memory result of its migration; listing uses every supported layout. | Per-file migrated values; the current layout only. | #38 |
| 2026-11-06 | **Maintainer decisions:** this document records promises and contracts, not mechanism, within 12,000 words; this log has one row per live decision. | Behavior and contracts (#86: the text grew back). | #97 |
| 2026-11-06 | **Maintainer decision:** reviews grade by promises (introduction, §14). | Grading any difference from text about mechanism. | #97 |
| 2026-11-06 | **Maintainer decision:** #39 and #43 wait for the first format v2 change; until then a migration backup refuses every write and `doctor` reports it as present. | Building recovery no v1 library needs. | #97 |
