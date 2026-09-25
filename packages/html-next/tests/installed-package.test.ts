import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageName = "@nextwebwg/html-next";
const useCommandShell = process.platform === "win32";
const enabled = process.env.HTMLNEXT_CONSUMER_TEST === "1";
const publicExports = [
  ".",
  "./runtime",
  "./live",
  "./generated-runtime",
  "./forms",
  "./validation",
  "./browser-loader",
  "./browser",
  "./node-loader",
] as const;
const browserExports = [
  "./runtime",
  "./live",
  "./generated-runtime",
  "./forms",
  "./validation",
  "./browser-loader",
  "./browser",
] as const;

function specifier(path: typeof publicExports[number]): string {
  return path === "." ? packageName : `${packageName}/${path.slice(2)}`;
}

describe.skipIf(!enabled)("installed package consumer", () => {
  let workspace = "";
  let consumer = "";
  let installedRoot = "";
  let manifest: {
    version: string;
    bin: Record<string, string>;
    exports: Record<string, { types: string; import: string }>;
  };

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "html-next-installed-package-"));
    const packed = await run(
      "corepack",
      ["pnpm", "pack", "--pack-destination", workspace],
      { cwd: packageRoot, shell: useCommandShell },
    );
    const output = packed.stdout.trim().split("\n").at(-1);
    assert.ok(output, "pnpm pack did not report a tarball path");
    const tarball = isAbsolute(output) ? output : join(workspace, output);
    consumer = join(workspace, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "installed-package-consumer", private: true, type: "module" }),
    );
    await run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumer, tarball],
      { cwd: workspace, shell: useCommandShell },
    );
    installedRoot = join(consumer, "node_modules", "@nextwebwg", "html-next");
    manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as typeof manifest;
  });

  afterAll(async () => {
    if (workspace !== "") await rm(workspace, { recursive: true, force: true });
  });

  it("ships JavaScript and declarations for every public export", async () => {
    assert.equal(manifest.version, "1.0.0-alpha.6");
    assert.deepEqual(Object.keys(manifest.exports), publicExports);
    for (const path of publicExports) {
      const entry = manifest.exports[path]!;
      await assert.doesNotReject(() => readFile(join(installedRoot, entry.import)));
      await assert.doesNotReject(() => readFile(join(installedRoot, entry.types)));
    }
  });

  it("installs and runs the public CLI", async () => {
    assert.deepEqual(manifest.bin, { "html-next": "./dist/cli.js" });
    await writeFile(
      join(consumer, "x-card.html"),
      '<template component="x-card" status="early" summary="Card."><article></article></template>',
    );
    const command = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "html-next.cmd" : "html-next",
    );
    await assert.doesNotReject(() => run(
      command,
      ["check", "x-card.html"],
      { cwd: consumer, shell: useCommandShell },
    ));
  });

  it("resolves every public export from consumer tools", async () => {
    const typeEntry = join(consumer, "public-exports.ts");
    await writeFile(
      typeEntry,
      `${publicExports.map((path, index) =>
        `import * as publicExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${publicExports.map((_, index) => `publicExport${index}`).join(", ")}];\n`,
    );
    try {
      await run(
        "corepack",
        [
          "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023",
          "--module", "NodeNext", "--moduleResolution", "NodeNext", typeEntry,
        ],
        { cwd: repositoryRoot, shell: useCommandShell },
      );
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`Installed package typecheck failed.\n${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: error });
    }

    const browserEntry = join(consumer, "browser-exports.ts");
    await writeFile(
      browserEntry,
      `${browserExports.map((path, index) =>
        `import * as browserExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${browserExports.map((_, index) => `browserExport${index}`).join(", ")}];\n`,
    );
    try {
      await run(
        "corepack",
        [
          "pnpm", "--filter", packageName, "exec", "esbuild", browserEntry, "--bundle", "--platform=browser",
          `--outfile=${join(consumer, "browser-exports.js")}`,
        ],
        { cwd: repositoryRoot, shell: useCommandShell },
      );
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`Installed package browser bundle failed.\n${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: error });
    }

    const nodeEntry = join(consumer, "node-exports.mjs");
    await writeFile(
      nodeEntry,
      `${publicExports
        .filter((path) => path !== "./browser")
        .map((path) => `import ${JSON.stringify(specifier(path))};`)
        .join("\n")}\nprocess.stdout.write("ok");\n`,
    );
    const imported = await run(process.execPath, [nodeEntry], { cwd: consumer });
    assert.equal(imported.stdout, "ok");
  });
});
