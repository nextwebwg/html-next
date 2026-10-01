import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { parseComponent } from "@nextwebwg/html-next";
import { compileScript, compileStyle, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { cases } from "../../html-next/tests/conformance/cases.js";
import { convertComponents, type ConversionGraph } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const baseStyle = "<style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>";
const successful = cases.filter((testCase) => "probe" in testCase.expect);

type HtmlNode = {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly sourceCodeLocation?: { readonly startOffset: number; readonly endOffset: number };
};

function scene(source: string): { readonly definition: string; readonly invocation: string } {
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes as readonly HtmlNode[];
  const carrier = nodes.find((node) => node.tagName === "template" && node.attrs?.some((attribute) => attribute.name === "component"));
  assert.ok(carrier?.sourceCodeLocation, "the shared case must contain a component definition");
  return {
    definition: source.slice(carrier.sourceCodeLocation.startOffset, carrier.sourceCodeLocation.endOffset),
    invocation: source.slice(carrier.sourceCodeLocation.endOffset),
  };
}

function consumer(invocation: string, tag: string, componentName: string, props: Readonly<Record<string, { readonly type: unknown }>>): string {
  const nodes = parseFragment(invocation).childNodes as readonly HtmlNode[];
  const render = (node: HtmlNode): string | undefined => {
    if (node.nodeName === "#comment") return undefined;
    if (node.nodeName === "#text") return node.value?.trim() === "" ? undefined : JSON.stringify(node.value);
    if (node.tagName === undefined) return undefined;
    const component = node.tagName === tag;
    const attributes: Record<string, unknown> = {};
    for (const attribute of node.attrs ?? []) {
      const propName = component ? Object.keys(props).find((name) => name.toLowerCase() === attribute.name) : undefined;
      const name = propName ?? attribute.name;
      const type = propName === undefined ? undefined : props[propName]?.type;
      attributes[name] = type === "number" && attribute.value.trim() !== "" && Number.isFinite(Number(attribute.value)) ? Number(attribute.value)
        : type === "boolean" ? attribute.value !== "false" : attribute.value;
    }
    const children = (node.childNodes ?? []).map(render).filter((child): child is string => child !== undefined);
    const name = component ? componentName : JSON.stringify(node.tagName);
    return component
      ? `h(${name}, ${JSON.stringify(attributes)}, ${children.length === 0 ? "undefined" : `{ default: () => [${children.join(", ")}] }`})`
      : `h(${name}, ${JSON.stringify(attributes)}, ${children.length === 0 ? "undefined" : `[${children.join(", ")}]`})`;
  };
  const children = nodes.map(render).filter((child): child is string => child !== undefined);
  assert.ok(children.length > 0, "the shared case must invoke a component");
  return children.length === 1 ? children[0]! : `[${children.join(", ")}]`;
}

function withoutStylingMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStylingMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "attributes" && Array.isArray(entry)
      ? entry.filter((attribute) => Array.isArray(attribute) &&
        typeof attribute[0] === "string" && attribute[0] !== "data-slotted" && !attribute[0].startsWith("data-v-"))
      : withoutStylingMarkers(entry),
  ]));
}

async function capturePixels(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.screenshot({ animations: "disabled" });
}

describe.skipIf(!enabled)("public Vue converter shared conformance parity", () => {
  let directory = "";
  let liveBundle = "";
  const artifacts = new Map<string, { readonly bundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-public-conformance-"));
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const [index, testCase] of successful.entries()) {
      const { definition, invocation } = scene(testCase.source);
      const parsedDefinition = parseComponent(definition, testCase.name);
      for (const mode of ["application", "library"] as const) {
        const caseDirectory = join(directory, String(index), mode);
        await mkdir(caseDirectory, { recursive: true });
        await writeFile(join(caseDirectory, "component.html"), definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode, target: "vue", entries: ["component.html"], root: caseDirectory, outDirectory });
        assert.deepEqual(manifest.components.map((component) => component.tag), [parsedDefinition.contract.tag]);
        assert.equal(manifest.output.entry, `vue/${mode === "application" ? "application" : "index"}.ts`);
        const component = manifest.components[0]!;
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        const scopeId = `data-v-public-${index}-${mode}`;
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: scopeId, inlineTemplate: true }).content);
        const serverScript = compileScript(parsed.descriptor, { id: scopeId });
        const serverTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: scopeId,
          ssr: true,
          ssrCssVars: [],
          scoped: parsed.descriptor.styles.some((style) => style.scoped === true),
          compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
        });
        assert.deepEqual(serverTemplate.errors, [], `Vue SSR compilation failed for ${testCase.name}`);
        await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
        const styles = parsed.descriptor.styles.map((style) => {
          const compiled = compileStyle({ source: style.content, filename: file, id: scopeId, scoped: style.scoped === true });
          assert.deepEqual(compiled.errors, []);
          return compiled.code;
        });
        const entry = join(outDirectory, "entry.ts");
        const bundle = join(outDirectory, "vue.js");
        await writeFile(entry, `import { createApp, createSSRApp, h } from "vue";
import { ${component.name} } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
${component.name}.__scopeId = ${JSON.stringify(scopeId)};
const create = window.hydrateVue ? createSSRApp : createApp;
create({ render: () => ${consumer(invocation, parsedDefinition.contract.tag, component.name, parsedDefinition.contract.props)} }).mount(document.querySelector("main"));\n`);
        await build({
          entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
          plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
          } }],
        });
        const serverEntry = join(outDirectory, "server.ts");
        await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { ${component.name} } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
${component.name}.__scopeId = ${JSON.stringify(scopeId)};
export const render = () => renderToString(createSSRApp({ render: () => ${consumer(invocation, parsedDefinition.contract.tag, component.name, parsedDefinition.contract.props)} }));\n`);
        const serverBuild = await build({
          entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
          plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
          } }],
        });
        const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
        const server = await serverModule.render() as string;
        artifacts.set(`${index}:${mode}`, { bundle, css: styles.join("\n"), server });
      }
    }
  }, 120_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const satisfies readonly ConversionGraph[]) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      describe(`${engine} ${mode}`, () => {
        let browser: Browser;
        beforeAll(async () => { browser = await launchParityBrowser(browserType); });
        afterAll(async () => { await browser?.close(); });

        for (const [index, testCase] of successful.entries()) {
          it(testCase.name, async () => {
            const [live, vue, hydrated] = await Promise.all([browser.newPage({ viewport: { width: 800, height: 600 } }), browser.newPage({ viewport: { width: 800, height: 600 } }), browser.newPage({ viewport: { width: 800, height: 600 } })]);
            const errors: string[] = [];
            const warnings: string[] = [];
            try {
              const { definition, invocation } = scene(testCase.source);
              const output = artifacts.get(`${index}:${mode}`)!;
              for (const page of [live, vue, hydrated]) page.on("pageerror", (error) => errors.push(error.message));
              hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await live.setContent(`${baseStyle}${definition}<main>${invocation}</main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
              await vue.setContent(`${baseStyle}<style>${output.css}</style><main></main>`);
              await vue.addScriptTag({ path: output.bundle });
              await hydrated.setContent(`${baseStyle}<style>${output.css}</style><main>${output.server}</main>`);
              const serverDOM = await hydrated.locator("main").evaluate((root) => root.innerHTML);
              assert.ok("probe" in testCase.expect);
              const program = `
                function snapshot(node) {
                  if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent };
                  return { tag: node.localName, attributes: Array.from(node.attributes).map(a => [a.name, a.value]).sort((x, y) => x[0].localeCompare(y[0])),
                    children: Array.from(node.childNodes).filter(n => !(n.nodeType === Node.TEXT_NODE && n.textContent.trim() === "") && n.nodeType !== Node.COMMENT_NODE && n.nodeType !== Node.PROCESSING_INSTRUCTION_NODE).map(snapshot) };
                }
                const q = (s) => document.querySelector(s);
                const qa = (s) => Array.from(document.querySelectorAll(s));
                ${testCase.expect.probe}`;
              // Ordinary SSR markup has no JavaScript validity facade until hydration.
              const requiresHydration = testCase.expect.probe.includes(".validity.");
              const [liveResult, vueResult, serverResult] = await Promise.all([
                live.evaluate((script) => Function(script)(), program),
                vue.evaluate((script) => Function(script)(), program),
                requiresHydration ? Promise.resolve(undefined) : hydrated.evaluate((script) => Function(script)(), program),
              ]);
              assert.deepEqual(liveResult, testCase.expect.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(vueResult), withoutStylingMarkers(liveResult), "public Vue browser behavior differs");
              if (!requiresHydration) assert.deepEqual(withoutStylingMarkers(serverResult), withoutStylingMarkers(liveResult), `public Vue server behavior differs: ${serverDOM}`);
              await assertPixelsEqual(vue, await capturePixels(vue), await capturePixels(live), "public Vue rendered pixels differ", live);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Vue server-rendered pixels differ", live);
              await hydrated.evaluate(() => { window.hydrateVue = true; });
              await hydrated.addScriptTag({ path: output.bundle });
              const hydratedResult = await hydrated.evaluate((script) => Function(script)(), program);
              assert.deepEqual(withoutStylingMarkers(hydratedResult), withoutStylingMarkers(liveResult),
                `public Vue hydrated behavior differs: before=${serverDOM} after=${await hydrated.locator("main").evaluate((root) => root.innerHTML)} warnings=${warnings.join(" | ")}`);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Vue hydrated pixels differ", live);
              if (testCase.name === "keeps a single native root when $with scopes the root") {
                for (const page of [live, vue, hydrated]) await page.locator("#person button").click();
                const read = (page: Page) => page.evaluate(() => {
                  const root = document.querySelector("#person")!;
                  return [root.localName, root.getAttribute("data-label"), root.querySelector("strong")?.textContent];
                });
                assert.deepEqual(await read(live), ["section", "Bea", "Bea"]);
                assert.deepEqual(await read(vue), await read(live), "reactive root $with behavior differs");
                assert.deepEqual(await read(hydrated), await read(live), "reactive hydrated root $with behavior differs");
                await assertPixelsEqual(vue, await capturePixels(vue), await capturePixels(live), "reactive root $with pixels differ", live);
                await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "reactive hydrated root $with pixels differ", live);
              }
              assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
              assert.deepEqual(errors, []);
            } finally {
              await Promise.all([live.close(), vue.close(), hydrated.close()]);
            }
          });
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void }; hydrateVue?: boolean }
}
