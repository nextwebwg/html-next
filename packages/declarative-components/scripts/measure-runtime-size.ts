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

async function generatedFixture(name: string, targetGzip: number): Promise<GeneratedMeasurement> {
  const sourceURL = new URL(`../benchmarks/fixtures/${name}.html`, import.meta.url);
  const source = await readFile(sourceURL, "utf8");
  const definition = parseComponent(source, sourceURL.href);
  const module = generateComponent(definition)
    .find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)?.content;
  if (module === undefined) throw new Error(`The ${name} fixture produced no Vanilla module.`);
  const result = await bundle({
    alias: { "@nextwebwg/declarative-components/runtime": runtimePath },
    external: ["*.css"],
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
const browserResult = await bundle({ entryPoints: [browserLoaderPath] });
const browserInputs = Object.keys(browserResult.metafile?.inputs ?? {});

process.stdout.write(`${JSON.stringify({
  static_generated_gzip: staticGenerated.gzip,
  reactive_generated_gzip: reactiveGenerated.gzip,
  live_browser_loader_gzip: size(browserResult).gzip,
  static_generated_bytes: staticGenerated.bytes,
  reactive_generated_bytes: reactiveGenerated.bytes,
  live_browser_loader_bytes: size(browserResult).bytes,
  browser_parse5_modules: browserInputs.filter((path) => path.includes("/parse5/")).length,
  static_target_met: staticGenerated.targetMet,
  reactive_target_met: reactiveGenerated.targetMet,
}, null, 2)}\n`);
