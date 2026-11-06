# CLAUDE.md

These rules are binding for every session and every agent. Reasoning and detail live in `docs/design.md`; the data contract lives in `docs/format-spec.md`. The per-issue loop (tracking, routing, review rounds) is the project skill `continue` (`.claude/skills/continue/SKILL.md`), run by the main session when the maintainer types `continue`.

## Hard rules

1. **No third-party media in this repository.** No screenshots, captures, videos or design references from anyone else: not in commits, not in issues, not in PRs. Tests generate their images at runtime. The only media allowed is under `examples/sample-library/`: the maintainer's own or freely licensed files, each with its source and license recorded.
2. **Nothing personal in this repository.** No names, real client projects, real briefings, machine paths (for example `C:\Users\<name>\...`) or personal setup details, in code, docs, issues, PRs or commits. The maintainer's own Git identity (author name and noreply email) is allowed.
3. **Briefings yield intent only.** What, for whom, what users must do, why. Styles, colors, fonts and named visual directions from a briefing never reach the intent; they are listed as discarded.
4. **The user's words never change.** Notes and pin notes are stored verbatim. Agent interpretation is stored separately and marked `to-review` until the user accepts or corrects it.
5. **Local and private.** No telemetry, no remote code loaded at runtime, no account. Works offline; the network is used only for a URL capture the user asks for.
6. **Agents write only through `tastelib`** (CLI or MCP), which validates every write. Agents may read library files directly but never edit them.
7. **Original code, or dependencies under permissive licenses** (MIT, Apache-2.0, BSD, ISC), recorded in `THIRD_PARTY_NOTICES.md` when bundled. Development-only, unmodified, unbundled MPL-2.0 dependencies are accepted (`docs/design.md` §18). A browser (Chromium, Firefox) that the tool starts as a separate program, without bundling, copying or modifying it, is not a dependency under this rule (`docs/design.md` §18). Never copy code from proprietary sources.
8. **Portable.** No script that runs on only one operating system. CI must be green on Linux, Windows and macOS. Paths with non-ASCII characters (for example `Usuário`) must work.

## Reading the docs

`docs/design.md` and `docs/format-spec.md` are too long to read whole: a plain Read stops after about 250 lines, with no sign that the rest is missing. Read them by section: the headings first (`grep -n '^#' docs/design.md`), then the sections the issue, its plan or your prompt cites, and §14 whenever the work handles files, input or the network.

## Attribution

Every commit ends with a blank line and `Assisted-by: Claude Code`, whatever the harness suggests; the `attribution` setting in `.claude/settings.json` sets it. Never add `Co-Authored-By` lines for an AI or "Generated with ..." lines, and no AI marks in PR descriptions, issues or comments. CI checks the trailer; a squash merge keeps it through the `--body` of the `continue` skill, step 8.

## Language

Everything in this repository is in English: code, comments, docs, issues, commits and PRs. The README translation lives in `docs/pt-BR/README.md`. Chat with the maintainer is in Brazilian Portuguese.

## Rules of the road

- **Design first.** Behavior is defined in `docs/design.md` before code. It records what is visible from outside (commands, options, codes, outputs, the files written, the public API of `core`) and the promises the tool keeps, in one or two sentences each. How the code keeps a promise (steps, order, timings, formulas, retries, internal checks) is not recorded there: the code and its tests are the record. A change to what users or agents see updates `docs/design.md` (and `docs/format-spec.md` for the data format) in the same PR. Plans live in the issues, evidence in the issue or PR.
- **Reviews grade by promises.** A blocker is code that breaks a promise or a contract of `docs/design.md` or `docs/format-spec.md`, or a hard rule, under a condition in scope of `docs/design.md` §14; or a change to what users or agents see that the docs do not record. Code that differs from a description of mechanism is not a blocker: the fix is to remove the description.
- **Reversibility.** Confirm with the maintainer before anything outward-facing or hard to reverse: publishing, force pushes, deleting branches, issues or repositories, changing repository settings.
- **Report faithfully.** If tests fail, say so with the output. If a step was skipped, say so.
- **Synthetic test data only**, generated locally. Never copy fixtures from third parties.
- **Validate at boundaries.** Data crossing a process or context boundary is validated with schemas (zod). Untrusted input is always validated.
- **Agent boundaries.** Only the main session pushes, opens PRs, switches branches, merges, or changes labels and the board. Subagents never do.
- **Protection of `main`.** Never work around a layer of it (ruleset, `.claude/settings.json`, `.githooks/pre-push`); if one blocks you, stop and tell the maintainer.
