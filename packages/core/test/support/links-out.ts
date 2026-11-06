import { cp, symlink } from "node:fs/promises";

/**
 * Helpers for tests of links that lead out of a library or into its working folders. Test-only: it
 * lives outside `src/`.
 */

/** A folder link: a junction on Windows (no extra rights), a plain directory link elsewhere. */
export async function folderLink(target: string, path: string): Promise<void> {
  await symlink(target, path, "junction");
}

/** A file link; `false` where Windows needs extra rights (administrator or Developer Mode) for one. */
export async function fileLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  }
}

/** Copies `from` to `to`, recursively. */
export async function copyFolder(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
}

/** A key name that appears only in the outside files of these tests, to prove it never leaks. */
export const SECRET_KEY = "outsideSecretKeyName";
