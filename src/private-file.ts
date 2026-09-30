import { writeFile, rename, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/** Writes a file readable by this user only, atomically (temp file + rename), so a reader never sees half of it. */
export async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
