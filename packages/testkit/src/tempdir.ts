import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Non-ASCII on purpose (docs/design.md section 15): portability rule for user paths. */
export const NON_ASCII_DIR_NAME = "Usuário-日本";

/**
 * Runs `fn` with a fresh temporary directory whose path contains non-ASCII characters
 * (`<tmp>/tastelib-XXXXXX/Usuário-日本`), and removes it afterwards, even on failure.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tastelib-"));
  const dir = join(root, NON_ASCII_DIR_NAME);
  try {
    await mkdir(dir);
    return await fn(dir);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
