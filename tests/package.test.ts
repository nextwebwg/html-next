import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "html-next-package-consumer-"));
const useCommandShell = process.platform === "win32";

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

describe("workspace package contracts", () => {
  it("installs Declarative Components without the independent Forms package", () => {
    const componentsTarball = pack("declarative-components");
    const consumer = join(workspace, "declarative-components-consumer");
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
      "declarative-components",
    );
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: unknown;
    };
    expect(manifest.exports).toBeDefined();
    expect(manifest.dependencies).not.toHaveProperty("@nextwebwg/html-forms");
    expect(existsSync(join(installedRoot, "dist", "index.d.ts"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "runtime.d.ts"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "generated-runtime.d.ts"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "browser.js"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "browser.d.ts"))).toBe(true);
    expect(existsSync(join(consumer, "node_modules", "@nextwebwg", "html-forms"))).toBe(false);
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "Promise.all([import('@nextwebwg/declarative-components'), import('@nextwebwg/declarative-components/runtime'), import('@nextwebwg/declarative-components/generated-runtime')]).then(() => process.stdout.write('ok'))",
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    ).toBe("ok");
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
});
