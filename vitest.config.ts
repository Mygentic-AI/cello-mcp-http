import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The endpoint loads whichever client is installed on the machine. Tests pin it to the devDependency.
    env: { CELLO_CLIENT_DIR: resolve(import.meta.dirname, "node_modules/@cello-protocol/cli") },
    include: ["src/**/*.test.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        maxThreads: 1,
        minThreads: 1,
      },
    },
  },
});
