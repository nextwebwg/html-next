import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildComponents } from "../src/cli.js";

async function snapshot(root: string, current = "", result: Record<string, string> = {}): Promise<Record<string, string>> {
  const directory = join(root, current);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = current === "" ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) await snapshot(root, path, result);
    else result[path] = await readFile(join(root, path), "utf8");
  }
  return result;
}

const temporary = await mkdtemp(join(tmpdir(), "html-next-generated-"));
try {
  await buildComponents(
    [fileURLToPath(new URL("../examples/x-button.html", import.meta.url))],
    temporary,
  );
  const expected = await snapshot(fileURLToPath(new URL("../examples/generated/", import.meta.url)));
  const actual = await snapshot(temporary);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("examples/generated is stale; run npm run build:example.");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
