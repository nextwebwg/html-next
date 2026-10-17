import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("ships an importable ESM reservation with declarations and no runtime dependencies", () => {
  const consumer = mkdtempSync(join(tmpdir(), "expressmark-consumer-"));
  const options = { cwd: consumer, encoding: "utf8" as const, shell: process.platform === "win32" };
  try {
    const [packed] = JSON.parse(execFileSync("npm", ["pack", root, "--ignore-scripts", "--json"], options)) as {
      filename: string; files: { path: string }[];
    }[];
    expect(packed).toBeDefined();
    const files = packed!.files.map(({ path }) => path);
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"]));
    expect(files.every((path) => /^(?:dist\/|LICENSE$|README.md$|package.json$)/.test(path))).toBe(true);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(consumer, packed!.filename)], options);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules/expressmark/package.json"), "utf8"));
    expect(installed.name).toBe("expressmark");
    expect(installed.license).toBe("MIT");
    expect(installed.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(consumer, "node_modules/expressmark/LICENSE"), "utf8"))
      .toBe(readFileSync(join(root, "../../LICENSE"), "utf8"));
    const exports = execFileSync(process.execPath, ["--input-type=module", "--eval",
      'import * as api from "expressmark"; console.log(JSON.stringify(Object.keys(api)));'], options);
    expect(JSON.parse(exports)).toEqual([]);
    writeFileSync(join(consumer, "index.ts"), 'import * as api from "expressmark"; void api;\n');
    const tsc = fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json")));
    execFileSync(process.execPath, [tsc, "--strict", "--noEmit", "--skipLibCheck", "--target", "ES2023",
      "--module", "NodeNext", "index.ts"], options);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
