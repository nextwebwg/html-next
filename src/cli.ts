#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateComponent,
  GENERATOR_VERSION,
  type GeneratedArtifact,
} from "./generate.js";
import { parseComponent } from "./parser.js";

export interface BuildManifest {
  readonly generatorVersion: string;
  readonly components: readonly {
    readonly source: string;
    readonly name: string;
    readonly tag: string;
    readonly artifacts: readonly string[];
  }[];
}

export async function buildComponents(
  entries: readonly string[],
  outDirectory: string,
): Promise<BuildManifest> {
  if (entries.length === 0) throw new Error("Build requires at least one component source.");

  const outputRoot = resolve(outDirectory);
  const artifacts = new Map<string, GeneratedArtifact>();
  const components: Array<BuildManifest["components"][number]> = [];

  for (const entry of [...entries].map((path) => resolve(path)).sort()) {
    const definition = parseComponent(await readFile(entry, "utf8"), entry);
    const generated = generateComponent(definition);
    for (const artifact of generated) {
      if (artifacts.has(artifact.path)) {
        throw new Error(`Generated artifact collision at ${artifact.path}.`);
      }
      artifacts.set(artifact.path, artifact);
    }
    components.push({
      source: relative(process.cwd(), entry).split(sep).join("/"),
      name: definition.contract.name,
      tag: definition.contract.tag,
      artifacts: generated.map((artifact) => artifact.path),
    });
  }

  await mkdir(outputRoot, { recursive: true });
  for (const artifact of artifacts.values()) {
    const path = resolve(outputRoot, artifact.path);
    if (path !== outputRoot && !path.startsWith(`${outputRoot}${sep}`)) {
      throw new Error(`Generated artifact escaped the output directory: ${artifact.path}.`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.content, "utf8");
  }

  const manifest: BuildManifest = {
    generatorVersion: GENERATOR_VERSION,
    components,
  };
  await writeFile(
    resolve(outputRoot, "html7.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function usage(): string {
  return "Usage: html7 build <component.html...> --out-dir <directory>";
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] !== "build") throw new Error(usage());
  const outIndex = argv.indexOf("--out-dir");
  const outDirectory = argv[outIndex + 1];
  if (outIndex < 2 || outIndex !== argv.length - 2 || outDirectory === undefined) {
    throw new Error(usage());
  }
  await buildComponents(argv.slice(1, outIndex), outDirectory);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
