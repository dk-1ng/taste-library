import { join } from "node:path";
import { rename } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { withGoldenCopy } from "../../test/support/golden.js";
import { fileLink, folderLink } from "../../test/support/links-out.js";
import { openLibrary } from "./open.js";

// The real `realpath` of the link whose name is in `failing` fails with EACCES; the rest is real.
const failing = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = (async (path: string, ...rest: never[]) => {
    if (failing.names.some((name) => String(path).endsWith(name))) {
      throw Object.assign(new Error("injected"), { code: "EACCES" });
    }
    return (original.realpath as (...a: unknown[]) => Promise<string>)(path, ...rest);
  }) as typeof original.realpath;
  return { ...original, realpath, default: { ...original, realpath } };
});

describe("a link whose target cannot be checked (docs/design.md section 4, Reading library files)", () => {
  it("is refused with a neutral message for a folder, and its files are unresolved", async () => {
    await withGoldenCopy(async (dir) => {
      await rename(join(dir, "families"), join(dir, "families-real"));
      await folderLink(join(dir, "families-real"), join(dir, "families"));
      failing.names = [join(dir, "families")];
      const opened = await openLibrary(dir);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      const issue = result.snapshot.issues.find((i) => i.file === "families");
      expect(issue).toMatchObject({ code: "unreadable-file" });
      expect(issue?.message).toBe(
        "The folder is a symbolic link or junction whose target could not be checked (EACCES).",
      );
      expect(result.snapshot.unlistedFolders).toContain("families");
      failing.names = [];
    });
  });

  it("is refused and never opened for a file, with a neutral message", async () => {
    await withGoldenCopy(async (dir) => {
      const file = join(dir, "references", "ref-20261105-zzzzzz.json");
      const real = join(dir, "references", "ref-20261101-a1b2c3.json");
      if (!(await fileLink(real, file))) return;
      failing.names = [file];
      const opened = await openLibrary(dir);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      failing.names = [];
      if (!result.ok) throw new Error(result.message);
      const loaded = result.snapshot.files.get("references/ref-20261105-zzzzzz.json");
      expect(loaded?.bytes).toBeNull();
      expect(loaded?.issues[0]).toMatchObject({
        code: "unreadable-file",
        message:
          "The file is a symbolic link or junction whose target could not be checked (EACCES), so it was not read.",
      });
    });
  });
});
