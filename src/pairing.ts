/**
 * The pairing code: proof that whoever approves an OAuth client is at the operator's machine.
 *
 * `cello-mcp-http pair` writes a fresh code to `<stateDir>/pairing` (mode 0600) and prints it. Only its
 * SHA-256 hash is written, so reading the file does not reveal the code. The server checks a submitted code
 * against that file: single use, expires, and five wrong attempts burn it.
 */
import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivate } from "./private-file.js";

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
// No 0/O, 1/I/L: the operator reads this off a terminal and types it into a browser.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface PairingFile { hash: string; expiresAt: number; attempts: number }

const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashOf = (code: string) => createHash("sha256").update(normalize(code)).digest("hex");

export async function createPairingCode(stateDir: string, opts: { ttlMs?: number } = {}): Promise<string> {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file: PairingFile = { hash: hashOf(code), expiresAt: Date.now() + (opts.ttlMs ?? PAIRING_TTL_MS), attempts: 0 };
  await writePrivate(join(stateDir, "pairing"), JSON.stringify(file));
  return code;
}

export type PairingResult = "ok" | "no_code" | "expired" | "wrong";

/** Checks a submitted code. Consumes it on success; counts and eventually burns it on failure. */
export async function consumePairingCode(stateDir: string, submitted: string): Promise<{ result: PairingResult; attemptsLeft: number }> {
  const path = join(stateDir, "pairing");
  let file: PairingFile;
  try {
    file = JSON.parse(await readFile(path, "utf8")) as PairingFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { result: "no_code", attemptsLeft: 0 };
    throw e;
  }
  if (Date.now() > file.expiresAt) {
    await rm(path, { force: true });
    return { result: "expired", attemptsLeft: 0 };
  }
  const match = timingSafeEqual(Buffer.from(hashOf(submitted), "hex"), Buffer.from(file.hash, "hex"));
  if (match) {
    await rm(path, { force: true });
    return { result: "ok", attemptsLeft: 0 };
  }
  file.attempts += 1;
  const attemptsLeft = PAIRING_MAX_ATTEMPTS - file.attempts;
  if (attemptsLeft <= 0) await rm(path, { force: true });
  else await writePrivate(path, JSON.stringify(file));
  return { result: "wrong", attemptsLeft: Math.max(0, attemptsLeft) };
}
