import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const repositoryLicense = readFileSync(join(root, "LICENSE"), "utf8");
const workspace = mkdtempSync(join(tmpdir(), "html-next-package-consumer-"));
const useCommandShell = process.platform === "win32";
const componentsPackage = "@nextwebwg/html-next";
const releaseDirectories = ["html-next", "html-next-converter", "html-next-unplugin"] as const;
const publicExports = [
  ".",
  "./runtime",
  "./live",
  "./generated-runtime",
  "./forms",
  "./validation",
  "./browser",
  "./node-loader",
  "./server",
] as const;
const browserExports = [
  "./runtime",
  "./live",
  "./generated-runtime",
  "./forms",
  "./validation",
  "./browser",
] as const;

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function pack(packageDirectory: string): string {
  const packageRoot = join(root, "packages", packageDirectory);
  const packed = execFileSync(
    "corepack",
    ["pnpm", "pack", "--pack-destination", workspace],
    { cwd: packageRoot, encoding: "utf8", shell: useCommandShell },
  )
    .trim()
    .split("\n")
    .at(-1);

  expect(packed).toBeDefined();
  return isAbsolute(packed!) ? packed! : join(workspace, packed!);
}

function specifier(path: typeof publicExports[number]): string {
  return path === "." ? componentsPackage : `${componentsPackage}/${path.slice(2)}`;
}

describe("workspace package contracts", () => {
  it("installs HTML Next with every public export", () => {
    const componentsTarball = pack("html-next");
    const consumer = join(workspace, "html-next-consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "package-consumer", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        componentsTarball,
      ],
      { cwd: consumer, shell: useCommandShell },
    );

    const installedRoot = join(
      consumer,
      "node_modules",
      "@nextwebwg",
      "html-next",
    );
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
      version: string;
      private?: boolean;
      license?: string;
      dependencies?: Record<string, string>;
      exports: Record<string, { types: string; import: string }>;
      repository?: { type: string; url: string; directory: string };
      publishConfig?: { access: string; tag: string; registry: string };
    };
    const sourceManifest = JSON.parse(readFileSync(join(root, "packages/html-next/package.json"), "utf8")) as { version: string };
    expect(manifest.version).toBe(sourceManifest.version);
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/nextwebwg/html-next.git",
      directory: "packages/html-next",
    });
    expect(manifest.publishConfig).toEqual({
      access: "public",
      tag: "latest",
      registry: "https://registry.npmjs.org/",
    });
    expect(readFileSync(join(installedRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    expect(Object.keys(manifest.exports)).toEqual(publicExports);
    for (const path of publicExports) {
      const entry = manifest.exports[path]!;
      expect(existsSync(join(installedRoot, entry.import))).toBe(true);
      expect(existsSync(join(installedRoot, entry.types))).toBe(true);
    }
    const nodeEntry = join(consumer, "node-exports.mjs");
    writeFileSync(
      nodeEntry,
      `${publicExports
        .filter((path) => path !== "./browser")
        .map((path) => `import ${JSON.stringify(specifier(path))};`)
        .join("\n")}\nconst { renderComponents } = await import("@nextwebwg/html-next/server");\nconst { parseComponent } = await import("@nextwebwg/html-next");\nconst rendered = await renderComponents("<x-packed>Package SSR</x-packed>", { definitions: [parseComponent('<template component="x-packed"><p><slot></slot></p></template>')] });\nif (!rendered.html.includes('data-component="x-packed"') || !rendered.html.includes("Package SSR")) throw new Error("Packaged server rendering failed");\nprocess.stdout.write("ok");\n`,
    );
    expect(
      execFileSync(process.execPath, [nodeEntry], { cwd: consumer, encoding: "utf8" }),
    ).toBe("ok");

    const typeEntry = join(consumer, "public-exports.ts");
    writeFileSync(
      typeEntry,
      `${publicExports.map((path, index) =>
        `import * as publicExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${publicExports.map((_, index) => `publicExport${index}`).join(", ")}];\n`,
    );
    execFileSync(
      "corepack",
      [
        "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
        "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", typeEntry,
      ],
      { cwd: root, shell: useCommandShell },
    );
    const browserEntry = join(consumer, "browser-exports.ts");
    writeFileSync(
      browserEntry,
      `${browserExports.map((path, index) =>
        `import * as browserExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${browserExports.map((_, index) => `browserExport${index}`).join(", ")}];\n`,
    );
    execFileSync(
      "corepack",
      [
        "pnpm", "--filter", componentsPackage, "exec", "esbuild", browserEntry, "--bundle", "--platform=browser",
        `--outfile=${join(consumer, "public-exports.js")}`,
      ],
      { cwd: root, shell: useCommandShell },
    );
  }, 120_000);

  it("publishes every workspace package publicly on the latest tag under MIT", () => {
    const versions = new Set<string>();
    for (const packageDirectory of releaseDirectories) {
      const packageRoot = join(root, "packages", packageDirectory);
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { version: string; private?: boolean; license?: string; publishConfig?: { access: string; tag: string } };
      versions.add(manifest.version);
      expect(manifest.private, packageDirectory).toBeUndefined();
      expect(manifest.publishConfig, packageDirectory).toMatchObject({ access: "public", tag: "latest" });
      expect(manifest.license, packageDirectory).toBe("MIT");
      expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    }
    expect([...versions], "All published packages must share one version.").toHaveLength(1);
  });
});
