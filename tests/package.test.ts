import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("installs both tarballs and exposes every public import", () => {
    const formsTarball = pack("html-forms");
    const componentsTarball = pack("declarative-components");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "package-consumer", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        formsTarball,
        componentsTarball,
      ],
      { cwd: workspace, shell: useCommandShell },
    );

    const installedRoot = join(
      workspace,
      "node_modules",
      "@nextwebwg",
      "declarative-components",
    );
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(manifest.exports).toBeDefined();
    expect(existsSync(join(installedRoot, "dist", "index.d.ts"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "runtime.d.ts"))).toBe(true);
    expect(existsSync(join(installedRoot, "dist", "generated-runtime.d.ts"))).toBe(true);
    expect(
      existsSync(
        join(workspace, "node_modules", "@nextwebwg", "html-forms", "dist", "index.d.ts"),
      ),
    ).toBe(true);
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "Promise.all([import('@nextwebwg/html-forms'), import('@nextwebwg/declarative-components'), import('@nextwebwg/declarative-components/runtime'), import('@nextwebwg/declarative-components/generated-runtime')]).then(() => process.stdout.write('ok'))",
        ],
        { cwd: workspace, encoding: "utf8" },
      ),
    ).toBe("ok");
  });
});
