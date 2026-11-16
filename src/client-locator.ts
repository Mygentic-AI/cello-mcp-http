/**
 * Finds the CELLO client already installed on this machine. The endpoint ships no copy of its own:
 * a second copy would be a different version from the one the daemon runs, and the tool list here
 * would stop matching the daemon behind it.
 *
 * Looked for in this order, and the first place that holds the client decides:
 *   1. CELLO_CLIENT_DIR, when set. It is followed exactly: a wrong value stops startup.
 *   2. Beside this package, in the same node_modules (a global install of both, or the hosted image).
 *   3. The `cello` command on PATH.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export const CLIENT_PACKAGE = "@cello-protocol/cli";
const [CLIENT_SCOPE, CLIENT_NAME] = CLIENT_PACKAGE.split("/") as [string, string];

/** The parts of the client this endpoint loads, by the names the client's own `exports` gives them. */
export const CLIENT_SUBPATHS = ["./operations", "./ipc-client", "./mcp-tools", "./paths"] as const;
export type ClientSubpath = (typeof CLIENT_SUBPATHS)[number];

export type ClientSource = "CELLO_CLIENT_DIR" | "beside" | "path";

export interface FoundClient {
  dir: string;
  version: string;
  source: ClientSource;
  /** Absolute file for each subpath. */
  files: Record<ClientSubpath, string>;
}

export type ClientProblem = "client_not_found" | "client_unusable";

export class ClientLocateError extends Error {
  constructor(readonly reason: ClientProblem, message: string) {
    super(message);
    this.name = "ClientLocateError";
  }
}

const INSTALL_HINT = `Install it with \`npm i -g ${CLIENT_PACKAGE}\`, or set CELLO_CLIENT_DIR to the folder that holds its package.json.`;

interface Manifest { name?: unknown; version?: unknown; exports?: unknown }

/** Undefined only when there is no package.json. One that can't be read or parsed stops the lookup: it is never skipped. */
function manifestAt(dir: string): Manifest | undefined {
  const file = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new ClientLocateError("client_unusable", `Can't read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text) as Manifest;
  } catch (e) {
    throw new ClientLocateError("client_unusable", `${file} isn't valid JSON, so the package there can't be identified: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isClient(dir: string): boolean {
  return manifestAt(dir)?.name === CLIENT_PACKAGE;
}

function exportedFile(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  const { import: asImport, default: asDefault } = entry as { import?: unknown; default?: unknown };
  if (typeof asImport === "string") return asImport;
  return typeof asDefault === "string" ? asDefault : undefined;
}

/** A folder known to hold the client, read into what the endpoint loads. A client it can't use stops startup. */
function use(dir: string, source: ClientSource): FoundClient {
  const manifest = manifestAt(dir) as Manifest;
  const version = typeof manifest.version === "string" ? manifest.version : "unknown";
  const exported = (manifest.exports ?? {}) as Record<string, unknown>;
  const files = {} as Record<ClientSubpath, string>;
  for (const sub of CLIENT_SUBPATHS) {
    const rel = exportedFile(exported[sub]);
    if (rel === undefined) {
      throw new ClientLocateError(
        "client_unusable",
        `The CELLO client at ${dir} (version ${version}) has no "${sub.slice(2)}" part, which this endpoint needs. Upgrade it: \`npm i -g ${CLIENT_PACKAGE}\`.`,
      );
    }
    const file = resolve(dir, rel);
    if (!existsSync(file)) {
      throw new ClientLocateError(
        "client_unusable",
        `The CELLO client at ${dir} (version ${version}) lists its "${sub.slice(2)}" part at ${file}, and that file isn't there. A checkout needs building first (\`npm run build\` in that folder); an install that lost files needs reinstalling.`,
      );
    }
    files[sub] = file;
  }
  return { dir, version, source, files };
}

/** The client package a file belongs to, following links first, or undefined when it belongs to something else. */
function clientOwning(file: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(realpathSync(file));
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return isClient(dir) ? dir : undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function onPath(pathVar: string, platform: string): string | undefined {
  for (const entry of pathVar.split(delimiter)) {
    // A relative entry means "wherever I happen to be standing", which is not an install.
    if (!isAbsolute(entry)) continue;
    const owner = clientOwning(join(entry, "cello"));
    if (owner !== undefined) return owner;
    // Windows: npm's global folder holds a `cello.cmd` beside its node_modules, and no link to follow.
    if (platform !== "win32" || !existsSync(join(entry, "cello.cmd"))) continue;
    const windows = join(entry, "node_modules", CLIENT_SCOPE, CLIENT_NAME);
    if (isClient(windows)) return windows;
  }
  return undefined;
}

export interface LocateInput {
  env: Readonly<Record<string, string | undefined>>;
  /** This package's own root folder. */
  ownDir: string;
  /** Defaults to the running platform. */
  platform?: string;
}

export function locateClient({ env, ownDir, platform = process.platform }: LocateInput): FoundClient {
  const named = env["CELLO_CLIENT_DIR"]?.trim();
  if (named !== undefined && named !== "") {
    const dir = resolve(named);
    if (!isClient(dir)) {
      throw new ClientLocateError("client_not_found", `CELLO_CLIENT_DIR is ${dir}, which doesn't hold the CELLO client (no package.json named ${CLIENT_PACKAGE}). ${INSTALL_HINT}`);
    }
    return use(dir, "CELLO_CLIENT_DIR");
  }

  const scopeDir = dirname(resolve(ownDir));
  const beside = join(scopeDir, CLIENT_NAME);
  if (basename(scopeDir) === CLIENT_SCOPE && isClient(beside)) return use(beside, "beside");

  const fromPath = onPath(env["PATH"] ?? "", platform);
  if (fromPath !== undefined) return use(fromPath, "path");

  throw new ClientLocateError(
    "client_not_found",
    `The CELLO client isn't installed where this endpoint can find it. It looked beside this package (${beside}) and for the \`cello\` command on PATH. ${INSTALL_HINT}`,
  );
}
