import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build, type BuildOptions, type BuildResult } from "esbuild";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import { classifyLiveRuntimeModules } from "./live-runtime-inventory.js";

interface SizeMeasurement {
  readonly bytes: number;
  readonly gzip: number;
}

interface GeneratedMeasurement extends SizeMeasurement {
  readonly fullRuntimeModules: number;
  readonly parserModules: number;
  readonly targetGzip: number;
  readonly targetMet: boolean;
}

const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const generatedRuntimePath = new URL("../src/generated-runtime.ts", import.meta.url).pathname;
const browserLoaderPath = new URL("../src/browser.ts", import.meta.url).pathname;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

const liveCapabilityModules = {
  componentGraph: "packages/declarative-components/src/graph.ts",
  controllerHost: "packages/declarative-components/src/controller.ts",
  declaredData: "packages/declarative-components/src/data.ts",
  expressionEvaluation: "packages/declarative-components/src/expression.ts",
  formEnhancement: "packages/html-forms/src/index.ts",
  generalRuntime: "packages/declarative-components/src/runtime.ts",
  jsonSchema: "packages/declarative-components/src/json-schema.ts",
  liveSource: "packages/declarative-components/src/browser-source.ts",
  proposalParser: "packages/declarative-components/src/parser.ts",
  reactivity: "packages/declarative-components/src/reactivity.ts",
  sanitization: "packages/declarative-components/src/sanitize.ts",
  scopedStyles: "packages/declarative-components/src/style.ts",
  typeSystem: "packages/declarative-components/src/type-system.ts",
  validation: "packages/declarative-components/src/validity.ts",
} as const;

async function bundle(options: BuildOptions): Promise<BuildResult> {
  return build({
    bundle: true,
    format: "esm",
    metafile: true,
    minify: true,
    platform: "browser",
    target: ["es2022"],
    treeShaking: true,
    write: false,
    ...options,
  });
}

function size(result: BuildResult): SizeMeasurement {
  const bytes = result.outputFiles?.[0]?.contents;
  if (bytes === undefined) throw new Error("The bundle produced no JavaScript output.");
  return { bytes: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}

function inputPath(path: string): string {
  return relative(repositoryRoot, resolve(packageRoot, path)).split(sep).join("/");
}

function moduleBytes(result: BuildResult): Readonly<Record<string, number>> {
  const output = Object.values(result.metafile?.outputs ?? {})[0];
  if (output === undefined) return {};
  return Object.fromEntries(
    Object.entries(output.inputs)
      .map(([path, contribution]) => [inputPath(path), contribution.bytesInOutput] as const)
      .sort((left, right) => right[1] - left[1]),
  );
}

async function generatedFixture(name: string, targetGzip: number): Promise<GeneratedMeasurement> {
  const sourceURL = new URL(`../benchmarks/fixtures/${name}.html`, import.meta.url);
  const source = await readFile(sourceURL, "utf8");
  const definition = parseComponent(source, sourceURL.href);
  const module = generateComponent(definition)
    .find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)?.content;
  if (module === undefined) throw new Error(`The ${name} fixture produced no Vanilla module.`);
  const result = await bundle({
    alias: {
      "@nextwebwg/declarative-components/generated-runtime": generatedRuntimePath,
      "@nextwebwg/declarative-components/runtime": runtimePath,
    },
    external: ["*.css", "./controller.js"],
    stdin: {
      contents: module,
      loader: "js",
      resolveDir: new URL("..", import.meta.url).pathname,
      sourcefile: `${definition.contract.name}.js`,
    },
  });
  const measured = size(result);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  return {
    ...measured,
    fullRuntimeModules: inputs.filter((path) => path.endsWith("/src/runtime.ts")).length,
    parserModules: inputs.filter((path) =>
      path.endsWith("/src/parser.ts") || path.endsWith("/src/source-parser.ts")
    ).length,
    targetGzip,
    targetMet: measured.gzip <= targetGzip,
  };
}

const staticGenerated = await generatedFixture("static-card", 2_500);
const reactiveGenerated = await generatedFixture("reactive-counter", 5_000);
const propGenerated = await generatedFixture("prop-button", 5_000);
const computedGenerated = await generatedFixture("computed-counter", 5_000);
const keyedGenerated = await generatedFixture("keyed-list", Number.POSITIVE_INFINITY);
const dataGenerated = await generatedFixture("data-read", Number.POSITIVE_INFINITY);
const formGenerated = await generatedFixture("enhanced-form", Number.POSITIVE_INFINITY);
const controllerGenerated = await generatedFixture("controller-lifecycle", Number.POSITIVE_INFINITY);
const browserResult = await bundle({ entryPoints: [browserLoaderPath] });
const browserInputs = Object.keys(browserResult.metafile?.inputs ?? {}).map(inputPath);
const generatedTargets = [staticGenerated, reactiveGenerated, propGenerated, computedGenerated];
const browserParse5Modules = browserInputs.filter((path) => path.includes("/parse5/")).length;
const browserDomInventoryModules = browserInputs.filter(
  (path) => path.includes("/generated/dom-properties"),
).length;
const missingLiveCapabilityModules = Object.values(liveCapabilityModules)
  .filter((path) => !browserInputs.includes(path));
const liveSize = size(browserResult);
const liveModuleBytes = moduleBytes(browserResult);
const liveSubsystemInventory = classifyLiveRuntimeModules(liveModuleBytes);

const liveDistributable = {
  mode: "live-browser-distributable",
  graph: "open",
  browserTarget: "es2022",
  bundleBoundary: "public-linkable-browser-entry",
  bundle: liveSize,
  capabilityProfile: {
    complete: missingLiveCapabilityModules.length === 0,
    requiredModules: liveCapabilityModules,
    missingModules: missingLiveCapabilityModules,
  },
  forbiddenServerModules: {
    parse5: browserParse5Modules,
    generatedDomPropertyInventory: browserDomInventoryModules,
  },
  moduleBytes: liveModuleBytes,
  subsystemInventory: liveSubsystemInventory,
} as const;

const nativeBuild = {
  mode: "native-application-or-library-build",
  graph: "fixture-specific-attribution",
  bundleBoundary: "isolated-generated-capability-fixture",
  capabilityFixtures: {
    static: staticGenerated,
    reactive: reactiveGenerated,
    prop: propGenerated,
    computed: computedGenerated,
    keyed: keyedGenerated,
    data: dataGenerated,
    form: formGenerated,
    controller: controllerGenerated,
  },
} as const;

const liveProfile = {
  live_distributable_gzip: liveSize.gzip,
  live_distributable_bytes: liveSize.bytes,
  live_distributable_complete_capability_profile:
    liveDistributable.capabilityProfile.complete ? 1 : 0,
  live_distributable_missing_capability_modules: missingLiveCapabilityModules,
  live_distributable_unclassified_modules:
    liveSubsystemInventory.unclassifiedModules.length,
  browser_parse5_modules: browserParse5Modules,
  browser_dom_property_inventory_modules: browserDomInventoryModules,
} as const;

const report = process.argv.includes("--profile=live-distributable")
  ? liveProfile
  : {
      live_distributable: liveDistributable,
      native_build: nativeBuild,
    };

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (
  generatedTargets.some((measurement) =>
    !measurement.targetMet || measurement.fullRuntimeModules > 0 || measurement.parserModules > 0
  ) ||
  missingLiveCapabilityModules.length > 0 ||
  liveSubsystemInventory.unclassifiedModules.length > 0 ||
  browserParse5Modules > 0 ||
  browserDomInventoryModules > 0
) {
  process.exitCode = 1;
}
