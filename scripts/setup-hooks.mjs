// Points Git at the versioned hooks. Runs from the `prepare` script after `pnpm install`.
// Outside a Git checkout (for example an exported archive) it does nothing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    console.warn("Could not set core.hooksPath; run: git config core.hooksPath .githooks");
  }
}
