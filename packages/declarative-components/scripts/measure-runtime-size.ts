import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import { build, type BuildOptions, type BuildResult } from "esbuild";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

interface SizeMeasurement {
  readonly bytes: number;
  readonly gzip: number;
}

interface GeneratedMeasurement extends SizeMeasurement {
  readonly targetGzip: number;
  readonly targetMet: boolean;
}

const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const generatedRuntimePath = new URL("../src/generated-runtime.ts", import.meta.url).pathname;
const browserLoaderPath = new URL("../src/browser-loader.ts", import.meta.url).pathname;

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

function moduleBytes(result: BuildResult): Readonly<Record<string, number>> {
  const output = Object.values(result.metafile?.outputs ?? {})[0];
  if (output === undefined) return {};
  return Object.fromEntries(
    Object.entries(output.inputs)
      .map(([path, contribution]) => [path.replace(/^.*\/src\//, "src/"), contribution.bytesInOutput] as const)
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
  return { ...measured, targetGzip, targetMet: measured.gzip <= targetGzip };
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
const browserInputs = Object.keys(browserResult.metafile?.inputs ?? {});
const generatedTargets = [staticGenerated, reactiveGenerated, propGenerated, computedGenerated];

process.stdout.write(`${JSON.stringify({
  static_generated_gzip: staticGenerated.gzip,
  reactive_generated_gzip: reactiveGenerated.gzip,
  prop_generated_gzip: propGenerated.gzip,
  computed_generated_gzip: computedGenerated.gzip,
  keyed_generated_gzip: keyedGenerated.gzip,
  data_generated_gzip: dataGenerated.gzip,
  form_generated_gzip: formGenerated.gzip,
  controller_generated_gzip: controllerGenerated.gzip,
  live_browser_loader_gzip: size(browserResult).gzip,
  static_generated_bytes: staticGenerated.bytes,
  reactive_generated_bytes: reactiveGenerated.bytes,
  prop_generated_bytes: propGenerated.bytes,
  computed_generated_bytes: computedGenerated.bytes,
  keyed_generated_bytes: keyedGenerated.bytes,
  data_generated_bytes: dataGenerated.bytes,
  form_generated_bytes: formGenerated.bytes,
  controller_generated_bytes: controllerGenerated.bytes,
  live_browser_loader_bytes: size(browserResult).bytes,
  live_browser_module_bytes: moduleBytes(browserResult),
  browser_parse5_modules: browserInputs.filter((path) => path.includes("/parse5/")).length,
  browser_dom_property_inventory_modules: browserInputs.filter(
    (path) => path.includes("/generated/dom-properties"),
  ).length,
  static_target_met: staticGenerated.targetMet,
  reactive_target_met: reactiveGenerated.targetMet,
  prop_target_met: propGenerated.targetMet,
  computed_target_met: computedGenerated.targetMet,
}, null, 2)}\n`);

if (generatedTargets.some((measurement) => !measurement.targetMet)) {
  process.exitCode = 1;
}
