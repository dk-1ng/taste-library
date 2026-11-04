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
| `web` | nothing yet (it runs in the browser, so it can use `core` only through a browser-safe entry point, decided when first needed) |

Each edge is both a `workspace:*` dependency and a TypeScript project reference. The graph has no cycles. `agent-kit/` is not a workspace package (it holds no TypeScript) and arrives in M3.

### Compiler configuration

- `tsconfig.base.json` holds the shared options: `target` and `lib` `es2025`, `module` `nodenext`, `types: []`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `forceConsistentCasingInFileNames`, `skipLibCheck`, `composite`, `declaration`, `declarationMap`, `sourceMap`. Paths use `${configDir}`, so every package compiles `src/` to `dist/` (`e2e` is the exception: it compiles `tests/` and its Playwright config, declarations only) and keeps its `.tsbuildinfo` inside `dist/` (deleting `dist/` forces a rebuild).
- Each package's `tsconfig.json` extends the base and adds only `types` and `references`, plus an `exclude` for `*.test.ts` when it has unit tests (type-checked by its `tsconfig.test.json`, §15). Node packages set `types: ["node"]` and write relative imports with the `.js` extension. `web` sets `module` `esnext`, `moduleResolution` `bundler`, `lib` `["es2025", "dom"]`.
- The root `tsconfig.json` is a solution file (`files: []`, references to every package and to the test configs) for editors and `tsc -b` from the root.
- The configuration avoids every option that TypeScript 6.0 deprecates, so moving to TypeScript 7 is a version bump (checked: 7.0.2 builds it unchanged).

### Build

- Each package's `build` script is `tsc -b`. `pnpm -r build` runs them in dependency order; `pnpm build` at the root does the same, and `pnpm clean` runs `tsc -b --clean`.
- `web` emits with `tsc` only until its app shell lands later in M0 with React and Vite; its build then becomes `tsc -b && vite build`.
- Scripts in any `package.json` call only cross-platform programs (`tsc`, `pnpm`, `vitest`, `playwright`, later `vite`). No shell built-ins (`rm`, `cp`, `mkdir -p`), no inline environment variables (`FOO=1 cmd`), no quoting or globbing that only a POSIX shell understands. A step that needs more is a Node script.

### Check command, lint and format

- `pnpm check` is the single gate, run locally, by agents (loop step 5) and in CI: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`. It stops at the first failure and exits non-zero.
- Biome does both linting (`recommended` rules; `pnpm lint` fails on warnings too) and formatting (2 spaces, double quotes, semicolons, 100 columns, LF). `pnpm format` rewrites files; `pnpm lint` and `pnpm format:check` only report.
- Biome is limited to code and data files (`.ts`, `.tsx`, `.js`, `.mjs`, `.json`), listed in `biome.json`. Markdown and YAML are not touched: it would reflow tables and prose in the design documents. It honors `.gitignore`.
- `pnpm typecheck` is `tsc -b`. `pnpm test` runs each package's `test` script when it has one (`pnpm -r --if-present test`); the test layout is in §15.
- `pnpm install` runs `prepare`, which runs `scripts/setup-hooks.mjs`: it sets `core.hooksPath` to `.githooks` in a Git checkout and does nothing elsewhere. New clones get the hooks without a manual step.
- Dependabot watches the npm ecosystem weekly with a 7-day cooldown, groups development dependencies into one PR and uses the `chore(deps)` prefix.


## 4. Library, media and configuration

- A **library** is a folder (usually its own private Git repository) holding the data files described in [format-spec.md](format-spec.md).
- **Media** (images, full-page captures, videos, frames) lives in a separate **media folder**, outside any Git repository. It can be any folder, including one kept in sync by a file-sync service; the tool never depends on a particular service.
- The tool refuses a media folder that sits inside a Git working tree, and `tastelib doctor` checks it.
- Media that a library references but that has not arrived yet (for example, still syncing from another computer) is shown as **awaiting sync**, never as an error.
- **Per-machine configuration** (where the library and the media folder are on this computer) lives outside the library: `~/.config/tastelib/config.json` on Linux and macOS, `%APPDATA%\tastelib\config.json` on Windows. It is never committed.

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

## 7. Interpretation and review

- Interpretation runs in **batches through an agent** ("process my new references"). For each piece, the agent proposes vocabulary, keywords, screen types, components, design aspects and, for negative pins, a guardrail.
- Everything the agent writes is marked **`to-review`**. In the app, a review queue offers **Accept** or **Correct**. Corrections are stored next to the original proposal.
- The user's own words are never altered.

## 8. Organization and taste tools

- **Aesthetic families emerge** from the collection. The agent proposes a name, a meaning and a vocabulary; the user accepts, renames or merges.
- Browsing also works by **screen or page type**, **component** and **design aspect**.
- Taste tools: **family pages**, a **taste profile** (likes, rejections, contradictions), a **vocabulary glossary**, and **side-by-side comparison**.

**(to specify in M4)**

## 9. Project spaces

- A project space pulls pieces from the library and adds its own layer: intent, directions, packs and results.
- **Intent:** the agent drafts it from any briefing dropped in, keeping only what, for whom, what users must do and why. Visual decisions, styles, colors, fonts and named directions are filtered out and listed as **discarded**. The user edits the result.
- **Directions:** the agent proposes about five (family + pieces + why it fits); the user adjusts.
- **Results loop:** screenshots of generated versions are pasted back into the project and pinned. They become references that sharpen the next packs and the taste profile.

**(to specify in M5)**

## 10. Export

An export is a folder `pack-<date>/` with:

- `README.md`: how to use the pack (directions side by side, then the build sequence).
- One subfolder per direction with `prompt.md` (Aesthetic · References · Intent · Guardrails), `image-prompts.md`, and `refs/` (a crop of each piece plus the whole image with the area highlighted).

By default the export folder contains its own `.gitignore` that ignores everything in it, so a pack placed inside any Git repository is never committed by accident. The user can turn this off per export.

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

## 13. Portability

- Linux and Windows are both first-class (macOS is expected to work).
- No script that runs on only one operating system. Git hooks are POSIX `sh`, which Git runs on every platform. Workflow helper scripts are Python (standard library only), which runs on every platform.
- Text files use LF (`.gitattributes`); the tool reads either line ending.
- Paths with non-ASCII characters (for example `Usuário`) are tested in CI.

## 14. Security

See [SECURITY.md](../SECURITY.md) for the sensitive surfaces. The local server listens on the loopback interface only and rejects cross-origin requests.

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
| 2026-11-04 | One issue per session: the maintainer runs `/clear` after each issue and types `continue`; `scripts/loop.py status` reads GitHub and says what to resume or start. | Relying on the agent's memory of earlier sessions. |
| 2026-11-04 | Workflow helper scripts are Python, standard library only; product code stays TypeScript. | Shell scripts (not portable to Windows); TypeScript before the toolchain exists in M0. |
| 2026-11-04 | The maintainer's own Git identity in commits is allowed under the "nothing personal" rule. | Rewriting history to a handle-only identity. |
| 2026-11-04 | Node 26, the Active LTS line since 2026-10-28 (26.13.0), pinned by `.nvmrc` and `engines` with `engineStrict`. | Node 24: in maintenance since October 2026. An exact patch in `.nvmrc`: blocks security releases without adding reproducibility (the lockfile does not depend on the Node patch). `devEngines.runtime` (pnpm downloads Node): more machinery than a version file every tool already reads. |
| 2026-11-04 | pnpm 12.16.1 pinned by `packageManager`; pnpm fetches the pinned version itself. | Corepack: no longer shipped with Node 25 and later. A global pnpm with no pin: versions drift between machines and CI. |
| 2026-11-04 | TypeScript 6.0.3, with a configuration that already builds unchanged on 7.0. Revisit when the linter chosen in M0 supports TypeScript 7. | TypeScript 7.0.2 (native compiler): no stable programmatic API until 7.1, and `typescript-eslint` 8.72 accepts only `typescript <6.1.0`. Speed does not matter at this size. Running both compilers (7 to build, 6 for tools): two type checkers that can disagree. |
| 2026-11-04 | Biome 2.6.4 for lint and format. It has its own parser and does not depend on the `typescript` package, so the TypeScript 7 move is not blocked by the linter. | ESLint + Prettier + `typescript-eslint`: three tools and about a dozen dependencies, and `typescript-eslint` ties the linter to the TypeScript version (see the TypeScript row). Biome's type-aware rules are weaker; `tsc` already covers type errors. |
| 2026-11-04 | Weak-copyleft dependencies (MPL-2.0) are accepted when they are development-only, unmodified and not bundled. First case: `lightningcss`, pulled by Vite through Vitest (and later by the `web` build). | Keeping hard rule 7 strict: it would exclude Vite and Vitest for one transitive CSS tool. A test runner without Vite (`node:test`): weaker tooling, and `web` brings the same package anyway. |
| 2026-11-04 | Packages build with `tsc -b` and project references, emitting `dist/` with declarations. | A bundler (tsup, tsdown, Rolldown) for the Node packages: an extra dependency that emits nothing `tsc` cannot. Bundling for distribution is decided at release (M7). Source-only packages run through a loader: the CLI and the MCP connector must run on plain Node. |
| 2026-11-04 | Vitest for unit tests (in `pnpm check`), Playwright for end-to-end tests (separate `pnpm test:e2e`), shared fixture helpers in a dev-only `packages/testkit`, images built by hand (PNG, BMP) instead of with an image library. | Jest (slower with ESM and TypeScript); Playwright inside `pnpm check` (forces a 120 MiB browser download on every install and CI run); helpers copied into each package; `sharp` or `pngjs` for fixtures (a native or extra dependency for something about 60 lines do). |
