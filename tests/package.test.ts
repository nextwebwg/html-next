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
const publicExports = [
  ".",
  "./runtime",
  "./generated-runtime",
  "./validation",
  "./browser-loader",
  "./browser",
  "./node-loader",
] as const;
const browserExports = [
  "./runtime",
  "./generated-runtime",
  "./validation",
  "./browser-loader",
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
  it("installs HTML Next without the independent Forms package", () => {
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
    expect(manifest.version).toBe("1.0.0-alpha.3");
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/nextwebwg/html-next.git",
      directory: "packages/html-next",
    });
    expect(manifest.publishConfig).toEqual({
      access: "public",
      tag: "next",
      registry: "https://registry.npmjs.org/",
    });
    expect(readFileSync(join(installedRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    expect(manifest.dependencies).not.toHaveProperty("@nextwebwg/html-forms");
    expect(Object.keys(manifest.exports)).toEqual(publicExports);
    for (const path of publicExports) {
      const entry = manifest.exports[path]!;
      expect(existsSync(join(installedRoot, entry.import))).toBe(true);
      expect(existsSync(join(installedRoot, entry.types))).toBe(true);
    }
    expect(existsSync(join(consumer, "node_modules", "@nextwebwg", "html-forms"))).toBe(false);

    const nodeEntry = join(consumer, "node-exports.mjs");
    writeFileSync(
      nodeEntry,
      `${publicExports
        .filter((path) => path !== "./browser")
        .map((path) => `import ${JSON.stringify(specifier(path))};`)
        .join("\n")}\nprocess.stdout.write("ok");\n`,
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
  });

  it("installs the Forms package independently", () => {
    const formsTarball = pack("html-forms");
    const consumer = join(workspace, "forms-consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "forms-consumer", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", formsTarball],
      { cwd: consumer, shell: useCommandShell },
    );

    const manifest = JSON.parse(
      readFileSync(
        join(consumer, "node_modules", "@nextwebwg", "html-forms", "package.json"),
        "utf8",
      ),
    ) as { license?: string };
    expect(manifest.license).toBe("MIT");
    expect(
      readFileSync(
        join(consumer, "node_modules", "@nextwebwg", "html-forms", "LICENSE"),
        "utf8",
      ),
    ).toBe(repositoryLicense);

    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "import('@nextwebwg/html-forms').then(() => process.stdout.write('ok'))",
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    ).toBe("ok");
  });

  it("publishes every workspace package publicly on the next tag under MIT", () => {
    for (const packageDirectory of [
      "html-next",
      "declarative-components-converter",
      "declarative-components-unplugin",
      "html-forms",
    ]) {
      const packageRoot = join(root, "packages", packageDirectory);
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { private?: boolean; license?: string; publishConfig?: { access: string; tag: string } };
      expect(manifest.private, packageDirectory).toBeUndefined();
      expect(manifest.publishConfig, packageDirectory).toMatchObject({ access: "public", tag: "next" });
      expect(manifest.license, packageDirectory).toBe("MIT");
      expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    }
  });
});
