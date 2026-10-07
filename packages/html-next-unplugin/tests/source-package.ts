import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Exercise the published files, not the author's working directory or generated output. */
export async function installSourcePackage(root: string, files: Record<string, string>): Promise<string> {
  const library = join(root, "node_modules", "@example", "controls");
  await rm(library, { recursive: true, force: true });
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "package.json"), JSON.stringify({
    name: "@example/controls", version: "1.0.0", type: "module", files: ["components"],
    exports: { ".": { "html-next": "./components/" }, "./nested": { "html-next": "./components/nested/" } },
  }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(library, path)), { recursive: true });
    await writeFile(join(library, path), content);
  }
  await writeFile(join(library, "unpublished.html"), "This file must not enter the package.");
  const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: library, shell: process.platform === "win32" });
  const [packed] = JSON.parse(stdout) as { filename: string; files: { path: string }[] }[];
  assert.deepEqual(packed!.files.map((file) => file.path).sort(), ["package.json", ...Object.keys(files)].sort());
  await rm(library, { recursive: true, force: true });
  await mkdir(library, { recursive: true });
  await run("tar", ["-xf", join(root, packed!.filename), "--strip-components=1", "-C", library]);
  return library;
}
