import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distJs = join(root, "dist", "index.js");
const distDts = join(root, "dist", "index.d.ts");

describe("dist package smoke", () => {
  it("builds and exports the public API from dist/", async () => {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: root,
      encoding: "utf8",
      shell: true,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    accessSync(distJs, constants.R_OK);
    accessSync(distDts, constants.R_OK);

    const mod = await import(pathToFileURL(distJs).href);
    assert.equal(typeof mod.MemoryMonitor, "function");
    assert.equal(typeof mod.detectMemoryLeak, "function");
    assert.equal(typeof mod.usedJsHeapSizeMb, "function");
    assert.equal(mod.MEMORY_EVENT.LEAK, "Detected potential memory leak");
    assert.equal(typeof mod.THRESHOLD_PRESETS.catastrophic.highUsageMb, "number");
    assert.ok(
      !("Logger" in mod),
      "stale Logger export must not ship in dist",
    );

    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as {
      exports: { ".": { types: string; default: string } };
      files: string[];
    };
    assert.equal(pkg.exports["."].default, "./dist/index.js");
    assert.equal(pkg.exports["."].types, "./dist/index.d.ts");
    assert.ok(pkg.files.includes("dist"));
  });
});
