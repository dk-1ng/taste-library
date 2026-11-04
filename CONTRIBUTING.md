# Contributing

Thanks for your interest. This project is directed by its maintainer and built with AI coding agents (see "How this project is built" in the README). The same rules apply to everyone.

## Scope

taste-library is a local app plus an agent kit for collecting design references, annotating them, organizing them into aesthetic families and exporting prompt packs for AI design work. It is local-first: no accounts, no cloud service, no telemetry.

Out of scope: hosting or sharing libraries online, scraping sites in bulk, bundling third-party design content, and integrating specific design or image-generation services (the tool produces their inputs and takes their outputs back).

## Hard rules

These are non-negotiable. `CLAUDE.md` holds the full wording.

1. No third-party media in this repository, its issues or its PRs. Tests generate their images at runtime.
2. Nothing personal: no names, real projects, real briefings or machine paths. (Your own Git author identity is fine.)
3. Briefings yield intent only; visual decisions are filtered out.
4. The user's words are stored verbatim; interpretation is kept separate.
5. Local and private: no telemetry, no remote code, no account, works offline.
6. Agents write library data only through `tastelib`.
7. Original code, or dependencies under permissive licenses.
8. Portable: Linux and Windows, including non-ASCII paths.

## Workflow

Everything goes through an issue. One issue = one branch = one pull request.

1. Pick or open an issue. Planned work uses the **Task** template; bugs and ideas use their own templates.
2. Create a branch from an up-to-date `main`: `<type>/<issue-number>-short-description`, for example `feat/12-url-capture`. Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.
3. Commit in small, logical steps (see Commits).
4. To bring in new commits from `main`, merge `main` into your branch. Do not rebase a pushed branch: force pushes are refused.
5. Open a pull request with the template filled in and `Closes #N`. CI must be green.
6. The maintainer approves; the PR is squash-merged and GitHub deletes the branch automatically.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), imperative mood, one logical change each:

```
feat(core): add reference schema

<optional body: why, not what>

Assisted-by: Claude Code
```

Scopes:

| Scope | Covers |
| --- | --- |
| `core` | data format, schemas, index, migrations, `docs/format-spec.md` |
| `server` | local server, URL capture, compression, video |
| `web` | user interface |
| `cli` | the `tastelib` command |
| `mcp` | MCP connector for other agents |
| `agent-kit` | Claude Code plugin and `AGENTS.md` |
| `i18n` | translations (en, pt-BR) |
| `ci` | GitHub Actions |
| `deps` | dependency updates |
| `docs` | general documentation |
| `repo` | workflow files: `CLAUDE.md`, templates, agents, hooks |

**Attribution trailer.** Every commit except merge commits ends with a blank line and an `Assisted-by:` trailer naming the AI tool used (in this project, `Assisted-by: Claude Code`), or `Assisted-by: none` if no AI tool was used. CI checks it on every pull request; Dependabot pull requests are exempt. Do not use `Co-Authored-By` for an AI, and do not add "Generated with ..." lines (CI refuses them in every commit).

## Pull requests

- Title = the Conventional Commit the squash will produce, for example `feat(core): add reference schema`.
- Body: `Closes #N`, what changes and why, how it was tested, and the checklist.
- Do not attach screenshots of third-party designs. Screenshots of the tool itself are fine.

## Local setup

Enable the repository's Git hooks once per clone:

```sh
git config core.hooksPath .githooks
```

The `pre-push` hook refuses pushes to `main` and force pushes.

### Toolchain

The pinned versions and the reasons behind them are in `docs/design.md` §3.

1. **Node.js 26 LTS, 26.13.0 or later.** `.nvmrc` names the line (`26`), so a version manager that reads it (nvm, fnm, Volta, mise and others) picks it up. `pnpm install` refuses an older Node.
2. **pnpm**, installed any way you like (the standalone installer, your system package manager, or `npm install --global pnpm`). pnpm reads `packageManager` in the root `package.json`, downloads the pinned version (12.16.1) and runs that one. Corepack is not needed.

Then, from the repository root:

```sh
pnpm install     # installs the exact versions in pnpm-lock.yaml
pnpm -r build    # builds every package in dependency order (same as: pnpm build)
pnpm clean       # removes the build output of every package
```

The code lives in `packages/` (`core`, `server`, `web`, `cli`, `mcp`), one workspace package each. Each package compiles `src/` to `dist/` with `tsc -b`; the shared compiler options are in `tsconfig.base.json`.

When you add a dependency, pnpm records the exact version (no `^` ranges) and the lockfile is committed. Shared development tools go in the root `package.json`; a package declares only what it needs at run time. Scripts in any `package.json` must run unchanged on Linux and Windows: no shell built-ins such as `rm` or `cp`, and no inline environment variables. The check command arrives later in M0.

Maintainer workflow helpers live in `scripts/` (Python 3.9+, standard library only, plus the GitHub CLI): `python3 scripts/loop.py status` shows what the per-issue loop should do next. Their tests run with `python3 -m unittest discover -s scripts`.

## Code standards

Defined in M0 and enforced by the check command. Until then: TypeScript, validation with zod at every boundary, tests next to the behavior, synthetic test data generated locally.

## Labels

| Group | Labels |
| --- | --- |
| type | `type: feature`, `type: bug`, `type: chore`, `type: docs`, `type: spike`, `type: checkpoint` |
| area | `area: core`, `area: server`, `area: web`, `area: cli`, `area: mcp`, `area: agent-kit` |
| platform | `platform: windows`, `platform: linux` |
| status | `status: triage`, `status: ready`, `status: in progress`, `status: blocked` |
| complexity | `complexity: high` |

`type: checkpoint` issues are pauses where the maintainer tests the tool in real use before work continues.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
