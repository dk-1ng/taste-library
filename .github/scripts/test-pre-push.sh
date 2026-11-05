#!/bin/sh
# Tests .githooks/pre-push in a throwaway repository. POSIX sh; runs on Linux, Windows and macOS (Git's sh).
set -eu

hook="$(cd "$(dirname "$0")/../.." && pwd)/.githooks/pre-push"
zero=0000000000000000000000000000000000000000
work="$(mktemp -d)"
trap 'cd /; rm -rf "$work" || true' EXIT
cd "$work"

git init -q -b main .
git config user.name test
git config user.email test@example.invalid
git commit -q --allow-empty -m one
a="$(git rev-parse HEAD)"
git commit -q --allow-empty -m two
b="$(git rev-parse HEAD)"
git checkout -q -b side "$a"
git commit -q --allow-empty -m other
c="$(git rev-parse HEAD)"

fails=0
expect() { # expect <0|1> <description> <stdin line>
  if printf '%s\n' "$3" | sh "$hook" origin url >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$1" ]; then echo "ok   - $2"; else echo "FAIL - $2 (exit $got, expected $1)"; fails=1; fi
}

expect 1 "refuses a push to main"            "refs/heads/feat $b refs/heads/main $a"
expect 1 "refuses creating main remotely"    "refs/heads/main $a refs/heads/main $zero"
expect 0 "allows a new feature branch"       "refs/heads/feat $b refs/heads/feat $zero"
expect 0 "allows a fast-forward push"        "refs/heads/feat $b refs/heads/feat $a"
expect 1 "refuses a non-fast-forward push"   "refs/heads/feat $c refs/heads/feat $b"
expect 1 "refuses when remote is unknown"    "refs/heads/feat $b refs/heads/feat 1111111111111111111111111111111111111111"
expect 0 "allows deleting a remote branch"   "(delete) $zero refs/heads/feat $b"

exit "$fails"
