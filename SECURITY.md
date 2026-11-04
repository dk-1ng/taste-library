# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/dk-1ng/taste-library/security/advisories/new). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You will get an answer as soon as the maintainer can look at it.

## Supported versions

Until version 1.0, only the latest commit on `main` is supported.

## Sensitive surfaces

taste-library runs on your machine and handles files you did not create. These are the areas where a flaw matters most:

| Surface | Risk |
| --- | --- |
| Local server | Must listen on the loopback interface only and reject requests from other origins (cross-site requests, DNS rebinding). |
| URL capture | Opens pages in a headless browser: hostile pages, requests to the local network, very large downloads. |
| Media processing | Decoding images and videos from untrusted sources (image and video libraries). |
| Library and export paths | Path traversal outside the library folder, the media folder or the chosen export folder. |
| Agent writes (CLI and MCP) | Every write must pass schema validation; agents must not be able to write outside the library. |
| Briefings and notes | Untrusted text shown in the UI (injection) and passed to agents (prompt injection). |

## Out of scope

The security of the AI agent you connect, of your sync service, and of the design or image services you use with exported packs.
