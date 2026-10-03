import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { parseComponent, parseTypeExpression, parseTypedValue, type TypeInput } from "@nextwebwg/html-next";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { cases } from "../../html-next/tests/conformance/cases.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
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

function consumer(invocation: string, tag: string, componentName: string, props: Readonly<Record<string, { readonly type: TypeInput }>>): string {
  const nodes = parseFragment(invocation).childNodes as readonly HtmlNode[];
  const render = (node: HtmlNode): string | undefined => {
    if (node.nodeName === "#comment") return undefined;
    if (node.nodeName === "#text") return node.value?.trim() === "" ? undefined : JSON.stringify(node.value);
    if (node.tagName === undefined) return undefined;
    const component = node.tagName === tag;
    const attributes: Record<string, unknown> = {};
    for (const attribute of node.attrs ?? []) {
      const propName = component ? Object.keys(props).find((name) => name.toLowerCase() === attribute.name) : undefined;
      const name = propName ?? (attribute.name === "class" ? "className" : attribute.name === "for" ? "htmlFor" : attribute.name);
      const type = propName === undefined ? undefined : props[propName]?.type;
      attributes[name] = name === "style" ? Object.fromEntries(attribute.value.split(";").filter(Boolean).map((declaration) => {
        const separator = declaration.indexOf(":");
        assert.ok(separator >= 0, `invalid invocation style: ${declaration}`);
        const property = declaration.slice(0, separator).trim().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        return [property, declaration.slice(separator + 1).trim()];
      })) : type === undefined ? attribute.value : (() => {
        const node = typeof type === "string" ? parseTypeExpression(type) : type;
        // A bare HTML boolean attribute is presence, while a React prop is a JavaScript value.
        if (attribute.value === "" && node.kind === "terminal" && node.name === "boolean") return true;
        const parsed = parseTypedValue(attribute.value, node, "$", "html");
        return parsed.ok ? parsed.value : attribute.value;
      })();
    }
    const children = (node.childNodes ?? []).map(render).filter((child): child is string => child !== undefined);
    return `createElement(${component ? componentName : JSON.stringify(node.tagName)}, ${JSON.stringify(attributes)}${children.length === 0 ? "" : `, ${children.join(", ")}`})`;
  };
  const children = nodes.map(render).filter((child): child is string => child !== undefined);
  assert.ok(children.length > 0, "the shared case must invoke a component");
  return children.length === 1 ? children[0]! : `createElement(Fragment, null, ${children.join(", ")})`;
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

describe.skipIf(!enabled)("public React converter shared conformance parity", () => {
  let directory = "";
  let liveBundle = "";
  const artifacts = new Map<string, { readonly bundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-public-conformance-"));
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
        const manifest = await convertComponents({ mode, target: "react", entries: ["component.html"], root: caseDirectory, outDirectory });
        assert.deepEqual(manifest.components.map((component) => component.tag), [parsedDefinition.contract.tag]);
        assert.equal(manifest.output.entry, `react/${mode === "application" ? "application" : "index"}.ts`);
        const component = manifest.components[0]!;
        const expression = consumer(invocation, parsedDefinition.contract.tag, component.name, parsedDefinition.contract.props);
        const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
        const css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
        const browserEntry = join(outDirectory, "browser.tsx");
        const bundle = join(outDirectory, "react.js");
        await writeFile(browserEntry, `import { createElement, Fragment } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { ${component.name} } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const root = document.querySelector("main")!;
const tree = ${expression};
if (root.hasChildNodes()) hydrateRoot(root, tree);
else createRoot(root).render(tree);
`);
        await build({ entryPoints: [browserEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
        const serverEntry = join(outDirectory, "server.tsx");
        await writeFile(serverEntry, `import { createElement, Fragment } from "react";
import { renderToString } from "react-dom/server";
import { ${component.name} } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
export const render = () => renderToString(${expression});
`);
        const serverBuild = await build({ entryPoints: [serverEntry], bundle: true, format: "cjs", platform: "node",
          write: false, packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
        const module = { exports: {} as { render(): string } };
        new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
        artifacts.set(`${index}:${mode}`, { bundle, css, server: module.exports.render() });
      }
    }
  }, 120_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      describe(`${engine} ${mode}`, () => {
        let browser: Browser;
        beforeAll(async () => { browser = await launchParityBrowser(browserType); });
        afterAll(async () => { await browser?.close(); });

        for (const [index, testCase] of successful.entries()) {
          it(testCase.name, async () => {
            const [live, react, hydrated] = await Promise.all([browser.newPage({ viewport: { width: 800, height: 600 } }),
              browser.newPage({ viewport: { width: 800, height: 600 } }), browser.newPage({ viewport: { width: 800, height: 600 } })]);
            const errors: string[] = [];
            try {
              const { definition, invocation } = scene(testCase.source);
              const output = artifacts.get(`${index}:${mode}`)!;
              for (const page of [live, react, hydrated]) page.on("pageerror", (error) => errors.push(error.message));
              await live.setContent(`${baseStyle}${definition}<main>${invocation}</main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
              await react.setContent(`${baseStyle}<style>${output.css}</style><main></main>`);
              await react.addScriptTag({ path: output.bundle });
              await hydrated.setContent(`${baseStyle}<style>${output.css}</style><main>${output.server}</main>`);
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
              // Server HTML has no JavaScript validity facade before hydration.
              const requiresHydration = testCase.expect.probe.includes(".validity.");
              await react.waitForFunction(() => document.querySelector("main")?.childElementCount !== 0);
              const [liveResult, reactResult, serverResult] = await Promise.all([live.evaluate((script) => Function(script)(), program),
                react.evaluate((script) => Function(script)(), program),
                requiresHydration ? Promise.resolve(undefined) : hydrated.evaluate((script) => Function(script)(), program)]);
              assert.deepEqual(liveResult, testCase.expect.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(reactResult), withoutStylingMarkers(liveResult), "public React browser behavior differs");
              if (!requiresHydration) assert.deepEqual(withoutStylingMarkers(serverResult), withoutStylingMarkers(liveResult), "public React server behavior differs");
              await assertPixelsEqual(react, await capturePixels(react), await capturePixels(live), "public React rendered pixels differ", live);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public React server-rendered pixels differ", live);
              await hydrated.addScriptTag({ path: output.bundle });
              if (requiresHydration) await hydrated.waitForFunction((script) => {
                try { Function(script)(); return true; } catch { return false; }
              }, program);
              const hydratedResult = await hydrated.evaluate((script) => Function(script)(), program);
              assert.deepEqual(withoutStylingMarkers(hydratedResult), withoutStylingMarkers(liveResult), "public React hydrated behavior differs");
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public React hydrated pixels differ", live);
              for (const step of testCase.expect.after ?? []) {
                await Promise.all([live, react, hydrated].map((page) => page.evaluate((action) => Function(action)(), step.action)));
                await Promise.all([live, react, hydrated].map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
                const [liveAfter, reactAfter, hydratedAfter] = await Promise.all([live, react, hydrated].map((page) => page.evaluate((script) => Function(script)(), program)));
                assert.deepEqual(liveAfter, step.result, "live runtime changed after interaction");
                assert.deepEqual(withoutStylingMarkers(reactAfter), withoutStylingMarkers(liveAfter), "React browser behavior differs after interaction");
                assert.deepEqual(withoutStylingMarkers(hydratedAfter), withoutStylingMarkers(liveAfter), "React hydrated behavior differs after interaction");
                await assertPixelsEqual(react, await capturePixels(react), await capturePixels(live), "React pixels differ after interaction", live);
                await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "React hydrated pixels differ after interaction", live);
              }
              assert.deepEqual(errors, []);
            } finally {
              await Promise.all([live.close(), react.close(), hydrated.close()]);
            }
          });
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
