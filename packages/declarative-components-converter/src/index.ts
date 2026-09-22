import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  loadNodeComponents,
  type GeneratedArtifact,
} from "@nextwebwg/declarative-components";

export type FrameworkTarget = "vue";
export type ConversionGraph = "application" | "library";

const targetVersions: Readonly<Record<FrameworkTarget, string>> = {
  vue: "3.5",
};

interface BaseConvertOptions {
  readonly entries: readonly string[];
  readonly target: FrameworkTarget;
  readonly targetVersion?: string;
  readonly outDirectory: string;
  readonly root?: string;
}

export interface ApplicationConvertOptions extends BaseConvertOptions {
  readonly mode: "application";
}

export interface LibraryConvertOptions extends BaseConvertOptions {
  readonly mode: "library";
}

export type ConvertOptions = ApplicationConvertOptions | LibraryConvertOptions;

export interface ConversionEntry {
  readonly source: string;
  readonly tag: string;
  readonly artifact: string;
}

export interface ConversionOutput {
  readonly path: string;
  readonly kind: "component" | "style" | "entry" | "inventory";
  readonly source?: string;
}

export interface ConversionManifest {
  readonly mode: "framework-conversion";
  readonly target: FrameworkTarget;
  readonly targetVersion: string;
  readonly graph: ConversionGraph;
  readonly entries: readonly ConversionEntry[];
  readonly output: {
    readonly entry: string;
    readonly inventory: "html-next.conversion.json";
    readonly artifacts: readonly ConversionOutput[];
  };
  readonly components: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly artifact: string;
    readonly style: string;
    readonly bridges: readonly string[];
  }[];
}

export class FrameworkOutputCollisionError extends Error {
  readonly code = "HTC002";

  constructor(
    readonly target: FrameworkTarget,
    readonly artifact: string,
    readonly sources: readonly [string, string],
  ) {
    super(
      `${sources[1]}: HTC002: ${target} output \`${artifact}\` collides with output from ${sources[0]}. Rename one component so each generated artifact has a distinct path.`,
    );
    this.name = "FrameworkOutputCollisionError";
  }
}

export class FrameworkDuplicateEntryError extends Error {
  readonly code = "HTC002";

  constructor(readonly source: string) {
    super(`${source}: HTC002: component entry is listed more than once.`);
    this.name = "FrameworkDuplicateEntryError";
  }
}

export class FrameworkTargetVersionError extends Error {
  readonly code = "HTC003";

  constructor(
    readonly target: FrameworkTarget,
    readonly requested: string,
    readonly supported: string,
  ) {
    super(`HTC003: ${target} ${requested} is not supported; this converter targets ${target} ${supported}.`);
    this.name = "FrameworkTargetVersionError";
  }
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

function frameworkEntry(
  mode: ConversionGraph,
  target: FrameworkTarget,
  entries: readonly ConversionEntry[],
): GeneratedArtifact {
  const exports = [...entries].sort((left, right) => left.artifact.localeCompare(right.artifact)).map((entry) => {
    const artifact = entry.artifact.slice(entry.artifact.lastIndexOf("/") + 1);
    const name = artifact.replace(/\.vue$/, "");
    return `export { default as ${name} } from ${JSON.stringify(`./${artifact}`)};`;
  });
  return {
    path: `${target}/${mode === "application" ? "application.ts" : "index.ts"}`,
    content: `${exports.join("\n")}\n`,
  };
}

export async function convertComponents(options: ConvertOptions): Promise<ConversionManifest> {
  if (options.entries.length === 0) throw new Error("Framework conversion requires at least one component entry.");
  const targetVersion = targetVersions[options.target];
  if (options.targetVersion !== undefined && options.targetVersion !== targetVersion) {
    throw new FrameworkTargetVersionError(options.target, options.targetVersion, targetVersion);
  }
  const projectRoot = resolve(options.root ?? process.cwd());
  const outputRoot = resolve(options.outDirectory);
  const entries = options.entries.map((entry) => pathToFileURL(resolve(projectRoot, entry)).href);
  const seenEntries = new Set<string>();
  for (const entry of entries) {
    if (seenEntries.has(entry)) {
      throw new FrameworkDuplicateEntryError(
        relative(projectRoot, fileURLToPath(entry)).split(sep).join("/"),
      );
    }
    seenEntries.add(entry);
  }
  const graph = await loadNodeComponents(entries, { baseURL: pathToFileURL(`${projectRoot}${sep}`).href });
  const manifestComponents: ConversionManifest["components"][number][] = [];
  const planned: Array<{ artifact: GeneratedArtifact; kind: ConversionOutput["kind"]; source?: string }> = [];
  const claimed = new Map<string, string>();
  const claim = (artifact: GeneratedArtifact, kind: ConversionOutput["kind"], source?: string): void => {
    const previous = claimed.get(artifact.path);
    if (previous !== undefined && previous !== source) {
      throw new FrameworkOutputCollisionError(options.target, artifact.path, [previous, source ?? "<generated>"]);
    }
    claimed.set(artifact.path, source ?? "<generated>");
    planned.push({ artifact, kind, ...(source === undefined ? {} : { source }) });
  };

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const source = relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/");
    const artifacts = generateComponent(node.definition);
    const component = frameworkArtifact(artifacts, options.target);
    if (/[@/]nextwebwg\/declarative-components\/runtime|attachComponent/.test(component.content)) {
      throw new FrameworkConversionError(
        options.target,
        source,
        node.definition.contract.tag,
      );
    }
    const style = styleArtifact(artifacts);
    const declarations = node.definition.declarations ?? [];
    const hasDeclaredEvents = declarations.some(({ kind }) => kind === "event");
    const hasDispatchedEvents = declarations.some((declaration) =>
      declaration.kind === "handler" && declaration.steps.some(({ kind }) => kind === "dispatch")
    );
    claim(component, "component", source);
    claim(style, "style", source);
    manifestComponents.push(Object.freeze({
      name: node.definition.contract.name,
      tag: node.definition.contract.tag,
      source,
      artifact: component.path,
      style: style.path,
      bridges: Object.freeze([
        ...(hasDeclaredEvents ? ["dom-event-callback"] : []),
        ...(hasDispatchedEvents ? ["typed-event-validation"] : []),
      ]),
    }));
  }

  const conversionEntries = entries.map((url) => {
    const node = graph.nodes.get(url);
    if (node === undefined) throw new Error(`Framework conversion did not resolve entry ${url}.`);
    const component = manifestComponents.find(({ source }) =>
      source === relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/")
    )!;
    return {
      source: component.source,
      tag: component.tag,
      artifact: component.artifact,
    };
  });
  const entry = frameworkEntry(options.mode, options.target, conversionEntries);
  claim(entry, "entry");
  const inventory = "html-next.conversion.json" as const;
  const outputArtifacts: ConversionOutput[] = planned.map(({ artifact, kind, source }) => ({
    path: artifact.path,
    kind,
    ...(source === undefined ? {} : { source }),
  }));
  outputArtifacts.push({ path: inventory, kind: "inventory" });

  const manifest: ConversionManifest = Object.freeze({
    mode: "framework-conversion",
    target: options.target,
    targetVersion,
    graph: options.mode,
    entries: Object.freeze(conversionEntries),
    output: Object.freeze({
      entry: entry.path,
      inventory,
      artifacts: Object.freeze(outputArtifacts),
    }),
    components: Object.freeze(manifestComponents),
  });
  for (const { artifact } of planned) await emit(outputRoot, artifact);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    resolve(outputRoot, inventory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
