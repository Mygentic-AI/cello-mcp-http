/**
 * The endpoint carries no copy of the CELLO client. It finds the one installed on the machine:
 * CELLO_CLIENT_DIR, then beside its own package, then the `cello` command on PATH. Every case here
 * builds real folders and links; nothing about the lookup is stubbed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocateError, CLIENT_SUBPATHS, locateClient } from "../client-locator.js";

let scratch = "";
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

function fresh(): string {
  scratch = mkdtempSync(join(tmpdir(), "client-locator-"));
  return scratch;
}

/** A folder shaped like an installed client. `drop` leaves one part out, as an older client would. */
function client(dir: string, opts: { version?: string; name?: string; drop?: string } = {}): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  const exports: Record<string, unknown> = {};
  for (const sub of CLIENT_SUBPATHS) {
    if (sub === opts.drop) continue;
    const file = `./dist/${sub.slice(2)}.js`;
    writeFileSync(join(dir, file), "export {};\n");
    exports[sub] = { types: `./dist/${sub.slice(2)}.d.ts`, default: file };
  }
  writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: opts.name ?? "@cello-protocol/cli", version: opts.version ?? "1.2.3", exports }));
  return dir;
}

/** A bin folder whose `cello` links into `target`, the way npm's global bin does. */
function binLinkingTo(root: string, target: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(target, "dist", "cli.js"), join(bin, "cello"));
  return bin;
}

function problem(run: () => unknown): ClientLocateError {
  try {
    run();
  } catch (e) {
    if (e instanceof ClientLocateError) return e;
    throw e;
  }
  throw new Error("expected the lookup to fail");
}

describe("finding the installed CELLO client", () => {
  it("uses the `cello` on PATH, following its link to the package that owns it", () => {
    const root = fresh();
    const installed = client(join(root, "lib", "node_modules", "@cello-protocol", "cli"), { version: "0.0.316" });
    const found = locateClient({ env: { PATH: `${join(root, "empty")}:${binLinkingTo(root, installed)}` }, ownDir: join(root, "endpoint") });
    expect(found.source).toBe("path");
    expect(found.version).toBe("0.0.316");
    expect(found.files["./mcp-tools"]).toMatch(/lib\/node_modules\/@cello-protocol\/cli\/dist\/mcp-tools\.js$/);
  });

  it("prefers the client beside its own package over a different one on PATH", () => {
    const root = fresh();
    const scope = join(root, "opt", "node_modules", "@cello-protocol");
    client(join(scope, "cli"), { version: "2.0.0" });
    const other = client(join(root, "elsewhere", "cli"), { version: "1.0.0" });
    const found = locateClient({ env: { PATH: binLinkingTo(root, other) }, ownDir: join(scope, "mcp-http") });
    expect(found.source).toBe("beside");
    expect(found.version).toBe("2.0.0");
  });

  it("does not take a neighbouring folder for the client unless it sits in the @cello-protocol scope", () => {
    const root = fresh();
    client(join(root, "code", "cli"));
    const e = problem(() => locateClient({ env: { PATH: "" }, ownDir: join(root, "code", "cello-mcp-http") }));
    expect(e.reason).toBe("client_not_found");
  });

  it("CELLO_CLIENT_DIR wins over both, and a blank one counts as unset", () => {
    const root = fresh();
    const named = client(join(root, "named"), { version: "3.0.0" });
    const onPath = client(join(root, "global", "cli"), { version: "1.0.0" });
    const PATH = binLinkingTo(root, onPath);
    expect(locateClient({ env: { CELLO_CLIENT_DIR: named, PATH }, ownDir: root }).version).toBe("3.0.0");
    expect(locateClient({ env: { CELLO_CLIENT_DIR: "  ", PATH }, ownDir: root }).version).toBe("1.0.0");
  });

  it("a CELLO_CLIENT_DIR that holds no client stops startup, and never falls back to PATH", () => {
    const root = fresh();
    const onPath = client(join(root, "global", "cli"));
    const wrong = client(join(root, "wrong"), { name: "something-else" });
    const e = problem(() => locateClient({ env: { CELLO_CLIENT_DIR: wrong, PATH: binLinkingTo(root, onPath) }, ownDir: root }));
    expect(e.reason).toBe("client_not_found");
    expect(e.message).toContain(wrong);
  });

  it("skips a different program that happens to be called `cello`", () => {
    const root = fresh();
    const impostor = client(join(root, "music", "cello-player"), { name: "cello-player" });
    const real = client(join(root, "real", "cli"), { version: "0.0.9" });
    const first = binLinkingTo(join(root, "a"), impostor);
    const second = binLinkingTo(join(root, "b"), real);
    expect(locateClient({ env: { PATH: `${first}:${second}` }, ownDir: root }).version).toBe("0.0.9");
  });

  it("with no client anywhere, says where it looked and how to install one", () => {
    const root = fresh();
    const e = problem(() => locateClient({ env: { PATH: join(root, "bin") }, ownDir: join(root, "endpoint") }));
    expect(e.reason).toBe("client_not_found");
    expect(e.message).toMatch(/npm i -g @cello-protocol\/cli/);
    expect(e.message).toMatch(/CELLO_CLIENT_DIR/);
  });

  it("a client too old to have a part it needs is named with its version, not passed over for another", () => {
    const root = fresh();
    const scope = join(root, "opt", "node_modules", "@cello-protocol");
    client(join(scope, "cli"), { version: "0.0.1", drop: "./mcp-tools" });
    const newer = client(join(root, "global", "cli"), { version: "9.9.9" });
    const e = problem(() => locateClient({ env: { PATH: binLinkingTo(root, newer) }, ownDir: join(scope, "mcp-http") }));
    expect(e.reason).toBe("client_unusable");
    expect(e.message).toContain("0.0.1");
    expect(e.message).toContain("mcp-tools");
  });

  it("a part the client lists but whose file is missing is unusable too", () => {
    const root = fresh();
    const dir = client(join(root, "named"));
    rmSync(join(dir, "dist", "paths.js"));
    expect(problem(() => locateClient({ env: { CELLO_CLIENT_DIR: dir }, ownDir: root })).reason).toBe("client_unusable");
  });
});
