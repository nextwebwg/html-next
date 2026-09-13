import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  loadNodeComponents,
  type GeneratedArtifact,
} from "@nextwebwg/declarative-components";

export type FrameworkTarget = "react" | "vue" | "svelte";

const targetVersions: Readonly<Record<FrameworkTarget, string>> = {
  react: "19",
  vue: "3.5",
  svelte: "5",
};

export interface ConvertOptions {
  readonly entries: readonly string[];
  readonly target: FrameworkTarget;
  readonly outDirectory: string;
  readonly root?: string;
}

export interface ConversionManifest {
  readonly mode: "framework-conversion";
  readonly target: FrameworkTarget;
  readonly targetVersion: string;
  readonly graph: "application-or-library";
  readonly components: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly artifact: string;
    readonly style: string;
    readonly bridges: readonly string[];
  }[];
}

export class FrameworkConversionError extends Error {
  readonly code = "HTC001";

  constructor(
    readonly target: FrameworkTarget,
    readonly source: string,
    readonly tag: string,
  ) {
    super(
      `${source}: HTC001: ${target} conversion for ${tag} requires semantics that are not yet expressed through target-native facilities.`,
    );
    this.name = "FrameworkConversionError";
  }
}

function frameworkArtifact(
  artifacts: readonly GeneratedArtifact[],
  target: FrameworkTarget,
): GeneratedArtifact {
  const artifact = artifacts.find((candidate) => candidate.path.startsWith(`${target}/`));
  if (artifact === undefined) throw new Error(`The ${target} generator produced no component artifact.`);
  return artifact;
}

function styleArtifact(artifacts: readonly GeneratedArtifact[]): GeneratedArtifact {
  const artifact = artifacts.find((candidate) => candidate.path.startsWith("styles/"));
  if (artifact === undefined) throw new Error("The framework generator produced no style artifact.");
  return artifact;
}

async function emit(root: string, artifact: GeneratedArtifact): Promise<void> {
  const output = resolve(root, artifact.path);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`Generated artifact escaped the output directory: ${artifact.path}.`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, artifact.content, "utf8");
}

export async function convertComponents(options: ConvertOptions): Promise<ConversionManifest> {
  if (options.entries.length === 0) throw new Error("Framework conversion requires at least one component entry.");
  const projectRoot = resolve(options.root ?? process.cwd());
  const outputRoot = resolve(options.outDirectory);
  const entries = options.entries.map((entry) => pathToFileURL(resolve(projectRoot, entry)).href);
  const graph = await loadNodeComponents(entries, { baseURL: pathToFileURL(`${projectRoot}${sep}`).href });
  const manifestComponents: ConversionManifest["components"][number][] = [];

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const artifacts = generateComponent(node.definition);
    const component = frameworkArtifact(artifacts, options.target);
    if (/[@/]nextwebwg\/declarative-components\/runtime|attachComponent/.test(component.content)) {
      throw new FrameworkConversionError(
        options.target,
        relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/"),
        node.definition.contract.tag,
      );
    }
    const style = styleArtifact(artifacts);
    await emit(outputRoot, component);
    await emit(outputRoot, style);
    manifestComponents.push(Object.freeze({
      name: node.definition.contract.name,
      tag: node.definition.contract.tag,
      source: relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/"),
      artifact: component.path,
      style: style.path,
      bridges: Object.freeze([]),
    }));
  }

  const manifest: ConversionManifest = Object.freeze({
    mode: "framework-conversion",
    target: options.target,
    targetVersion: targetVersions[options.target],
    graph: "application-or-library",
    components: Object.freeze(manifestComponents),
  });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    resolve(outputRoot, "html-next.conversion.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
