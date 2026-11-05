# taste-library

A local-first design taste library for people who build with AI coding agents.

[Português (Brasil)](docs/pt-BR/README.md)

> **Status:** early development, public so that the work can be followed. Nothing to install yet, no license yet (all rights reserved until the first release), and outside contributions are not accepted yet.

## What it is for

AI-generated interfaces tend to look alike. taste-library helps you bring your own taste into AI-assisted design:

1. **Collect** references: paste screenshots, page URLs (captured full-page) or short videos.
2. **Annotate** them in your own words, and mark the parts you like and the parts you don't.
3. **Organize** them: aesthetic families emerge from your collection, with their vocabulary, and you can browse by screen type, component and design aspect.
4. **Export** prompt packs for a project: aesthetic, numbered references, intent and guardrails, ready to hand to your coding agent or image tool.
5. **Bring results back** and let them sharpen the next round.

It runs on your computer, opens in your browser, works offline and stores everything as plain files in folders you choose. A Claude Code plugin and an MCP connector let your agent do the interpretation work on the same files.

## How this project is built

This project is directed by its maintainer and executed with AI coding agents (Claude Code), and it has been since the very first commit. The workflow is versioned with the code: `CLAUDE.md` holds the rules and the per-issue loop, and `.claude/agents/` defines the specialized agents. Every change goes through an issue, a branch, an automated review and a pull request, and is merged only after the maintainer reviews and approves it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

None yet: all rights are reserved until a license is chosen, before the first release.
