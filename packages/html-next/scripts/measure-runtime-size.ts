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
  /** Modules a compiled bundle must never contribute: the interpreter, parsers and type system. */
  readonly forbiddenModules: readonly string[];
  readonly targetGzip: number;
  readonly targetMet: boolean;
}

const forbiddenModule = /(?:^|\/)src\/(?:runtime|parser|source-parser|expression-parser|type-system|format)\.ts$/;

const runtimePath = fileURLToPath(new URL("../src/runtime.ts", import.meta.url));
const generatedRuntimePath = fileURLToPath(new URL("../src/generated-runtime.ts", import.meta.url));
const browserLoaderPath = fileURLToPath(new URL("../src/browser.ts", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

const liveCapabilityModules = {
  componentGraph: "packages/html-next/src/graph.ts",
  controllerHost: "packages/html-next/src/controller.ts",
  declaredData: "packages/html-next/src/data.ts",
  expressionEvaluation: "packages/html-next/src/expression.ts",
  generalRuntime: "packages/html-next/src/runtime.ts",
  liveSource: "packages/html-next/src/browser-source.ts",
  proposalParser: "packages/html-next/src/parser.ts",
  reactivity: "packages/html-next/src/reactivity.ts",
  sanitization: "packages/html-next/src/sanitize.ts",
  scopedStyles: "packages/html-next/src/component-styles.ts",
  typeSystem: "packages/html-next/src/type-system.ts",
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
  // Each fixture is its own closed graph, as a build compiles it: nothing reads its state as context.
  const module = generateComponent(definition, { noContextReaders: true })
    .find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)?.content;
  if (module === undefined) throw new Error(`The ${name} fixture produced no Vanilla module.`);
  const result = await bundle({
    alias: {
      "@nextwebwg/html-next/generated-runtime": generatedRuntimePath,
      "@nextwebwg/html-next/runtime": runtimePath,
    },
    external: ["*.css", "./controller.js"],
    stdin: {
      contents: module,
      loader: "js",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: `${definition.contract.name}.js`,
    },
  });
  const measured = size(result);
  // Modules that contribute output; a module esbuild parsed and shook out entirely does not count.
  const inputs = Object.entries(moduleBytes(result)).filter(([, bytes]) => bytes > 0).map(([path]) => path);
  return {
    ...measured,
    fullRuntimeModules: inputs.filter((path) => path.endsWith("/src/runtime.ts")).length,
    parserModules: inputs.filter((path) =>
      path.endsWith("/src/parser.ts") || path.endsWith("/src/source-parser.ts")
    ).length,
    forbiddenModules: inputs.filter((path) => forbiddenModule.test(path)),
    targetGzip,
    targetMet: measured.gzip <= targetGzip,
  };
}

// Every component compiles through the one block compiler, with live's semantics. The smaller
// emitters these four fixtures once used (0.3–2 KB) did not match live: no slot markers, no host,
// inspection or hydration, and their own prop validity messages. Exact output carries the compiled
// root's handle, host and scheduler (~6.6 KB) and, with props, the live prop boundary and validity
// with each prop's type compiled to its own checks (~4.4 KB more, from ~12 KB through the type system).
// A component with a slot also carries live's slot rules (+~250 B): a consumer's <template slot> renders
// only while its outlet renders, host.slots lists what it renders, and a component projected into a
// slot is created only once a slot places it. Every fixture carries the platform-object check
// (`isPlatformObject`, about 70 B gzip) that keeps DOM nodes in state unwrapped, since a browser
// rejects a proxy as a native getter's receiver.
// +80 B on every fixture: `host.on` records each listener as a known responder on the document's
// record and tells `hasResponder` readers, so a component that asks sees a consumer's controller
// that registered first (javascript#has-responder).
// +85 B on every fixture with a slot: a slot fills from what a consumer's `$if` and `$each` regions
// hold now and, given only such regions, switches to its fallback while they render nothing. The
// switch itself ships only with a consumer that projects such regions (`slotRegion`).
const staticGenerated = await generatedFixture("static-card", 7_400);
// The counters' `number` arithmetic bundles its decimal operations (src/decimal.ts): `$count + 1`
// imports `add` (+256 B gzip) and the computed counter's `$count * 2` adds `multiply` (+294 B in all).
// +5 B: the minifier names this bundle's identifiers differently beside the generated runtime's head exports,
// which the bundle does not include.
const reactiveGenerated = await generatedFixture("reactive-counter", 7_560);
const propGenerated = await generatedFixture("prop-button", 11_920);
// A component with computeds also bundles the read-only view live's host gives them (nested writes refused).
const computedGenerated = await generatedFixture("computed-counter", 7_878);
// These compiled through the general runtime (~39 KB) until every component compiled directly.
const keyedGenerated = await generatedFixture("keyed-list", 8_035);
// +5 B: a root renders, at its first connection, what changed after its construction while it waited
// detached, such as a parent's bound list of objects; until then such a change never rendered.
// +12 B: `host.on` relays a late responder to the requests that went unanswered, a guarded call that
// does nothing until a component on the page asks.
const dataGenerated = await generatedFixture("data-read", 7_970);
const controllerGenerated = await generatedFixture("controller-lifecycle", 7_400);
// The controller fixture plus one request: the request steps, `host.request` and `host.on`'s
// responder filter (requests.ts, ~1 KB gzip), and checks written for its declared detail and answer.
// +600 B: `host.hasResponder`, and `RequestEvent`'s static `respond`, `request` and `hasResponder`,
// which ship with the class every request dispatches.
const requestGenerated = await generatedFixture("controller-request", 9_110);
// Head declarations, each fixture the one before plus a feature: a page with a bound prop and no head
// declarations; a title and two metas (+2.1 KB: the head manager's keys, precedence, set-aside and
// restore, JSON-LD blocks per instance and declaration, and one reconciliation per update); bound
// JSON-LD (+0.15 KB, its serialization); a lazy declared script (+2.0 KB: the script entries, status,
// `on:load` and lazy loading).
const headNoneGenerated = await generatedFixture("head-none", 10_531);
const headStaticGenerated = await generatedFixture("head-static", 12_649);
const headJsonGenerated = await generatedFixture("head-json", 12_800);
const headGenerated = await generatedFixture("head-script", 14_784);
// The benchmark shape on the direct path: no interpreter, parser or type system may reach it.
// Ratcheted to the measurement after the indexed coordinator split (7,528 B) + 3%, then by 25 B
// for the controller host's prop channel (`host.props` and prop writes) that every prop component
// uses, 25 B for a host root that follows a root `$match` switch, as live's does, 50 B for the
// node methods through which keyed lists also hold rows of several nodes, and 15 B for the reconcile
// recording the rows it kept in place, so lists whose rows read their position visit only moved rows,
// 85 B for the platform-object check that keeps DOM nodes in state unwrapped, and 17 B for the
// whitespace between its elements, which templates keep as authored.
const controllerKeyedGenerated = await generatedFixture("controller-keyed", 8_604);
const browserResult = await bundle({ entryPoints: [browserLoaderPath] });
const browserInputs = Object.keys(browserResult.metafile?.inputs ?? {}).map(inputPath);
const generatedTargets = [staticGenerated, reactiveGenerated, propGenerated, computedGenerated, controllerKeyedGenerated, requestGenerated, headNoneGenerated, headStaticGenerated, headJsonGenerated, headGenerated];
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
    controller: controllerGenerated,
    request: requestGenerated,
    headNone: headNoneGenerated,
    headStatic: headStaticGenerated,
    headJson: headJsonGenerated,
    headScript: headGenerated,
    controllerKeyed: controllerKeyedGenerated,
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
    !measurement.targetMet || measurement.fullRuntimeModules > 0 || measurement.parserModules > 0 ||
    measurement.forbiddenModules.length > 0
  ) ||
  missingLiveCapabilityModules.length > 0 ||
  liveSubsystemInventory.unclassifiedModules.length > 0 ||
  browserParse5Modules > 0 ||
  browserDomInventoryModules > 0
) {
  process.exitCode = 1;
}
