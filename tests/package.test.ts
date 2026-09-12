import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(root, "packages", "declarative-components");
const workspace = mkdtempSync(join(tmpdir(), "html-next-package-consumer-"));
const useCommandShell = process.platform === "win32";

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe("declarative-components package", () => {
  it("installs its tarball and exposes both public imports", () => {
    const packed = execFileSync(
      "corepack",
      ["pnpm", "pack", "--pack-destination", workspace],
      { cwd: packageRoot, encoding: "utf8", shell: useCommandShell },
    )
      .trim()
      .split("\n")
      .at(-1);

    expect(packed).toBeDefined();
    const tarball = isAbsolute(packed!) ? packed! : join(workspace, packed!);
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "package-consumer", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
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
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "Promise.all([import('@nextwebwg/declarative-components'), import('@nextwebwg/declarative-components/runtime')]).then(() => process.stdout.write('ok'))",
        ],
        { cwd: workspace, encoding: "utf8" },
      ),
    ).toBe("ok");
  });
});
