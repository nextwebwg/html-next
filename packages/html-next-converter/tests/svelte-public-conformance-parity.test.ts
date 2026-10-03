import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build, type Plugin } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { compile } from "svelte/compiler";

import { parseComponent } from "@nextwebwg/html-next";
import { cases } from "../../html-next/tests/conformance/cases.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
const baseStyle = "<style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>";

// Grow this list as feature slices land. It deliberately uses the same public cases as Vue and React.
const selected = new Set([
  "HTML parser recovery keeps the first duplicate attribute",
  "preserves SVG namespaces and camelCase attributes inside a native root",
  "keeps a single native root when $with scopes the root",
  "lowers to native root with prop :attr, passthrough attrs, and default slot",
  "lets invocation attributes win over template literals and combines class and style",
  "serializes booleans on enumerated attributes as true and false",
  "styles by camel-case props and state with :host-state()",
  "applies a prop default when the invocation omits the prop",
  "coerces number, boolean, enum, and string props",
  "attribute serialization: absent/false remove, true is present-empty, number stringifies, list space-joins",
  "invocation attributes named after Object prototype members pass through",
  "$value renders escaped text (a <b> in data is literal characters)",
  "<template $value> renders inline text with no wrapper element",
  "invalid $html expressions retain the last sanitized content",
]);
const successful = cases.filter((testCase) => selected.has(testCase.name) && "probe" in testCase.expect);
assert.equal(successful.length, selected.size, "Every selected public case must still exist");

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

function consumer(invocation: string, tag: string, name: string, props: Readonly<Record<string, { readonly type: unknown }>>): string {
  const nodes = parseFragment(invocation).childNodes as readonly HtmlNode[];
  const render = (node: HtmlNode): string => {
    if (node.nodeName === "#text") return node.value?.trim() === "" ? "" : `{${JSON.stringify(node.value)}}`;
    if (node.tagName === undefined) return "";
    const component = node.tagName === tag;
    const attributes = (node.attrs ?? []).map(({ name: attribute, value }) => {
      const prop = component ? Object.keys(props).find((key) => key.toLowerCase() === attribute) : undefined;
      const type = prop === undefined ? undefined : props[prop]?.type;
      const typed = type === "number" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value)
        : type === "boolean" ? value !== "false" : value;
      return `${prop ?? attribute}={${JSON.stringify(typed)}}`;
    }).join(" ");
    const element = component ? name : node.tagName;
    const open = `<${element}${attributes === "" ? "" : ` ${attributes}`}`;
    const children = (node.childNodes ?? []).map(render).join("");
    if (children === "") return `${open} />`;
    return `${open}>${children}</${element}>`;
  };
  const markup = nodes.map(render).join("");
  assert.notEqual(markup, "", "the shared case must invoke a component");
  return markup;
}

function withoutStylingMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStylingMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "attributes" && Array.isArray(entry)
      ? entry.filter((attribute) => Array.isArray(attribute) && attribute[0] !== "data-slotted")
      : withoutStylingMarkers(entry),
  ]));
}

function sveltePlugin(generate: "client" | "server"): Plugin {
  return { name: `svelte-${generate}`, setup(plugin) {
    plugin.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
      contents: compile(await readFile(path, "utf8"), { filename: path, generate }).js.code,
      loader: "js",
      resolveDir: dirname(path),
    }));
  } };
}

async function capturePixels(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.screenshot({ animations: "disabled" });
}

describe.skipIf(!enabled)("public Svelte converter shared conformance parity", () => {
  let directory = "";
  let liveBundle = "";
  const artifacts = new Map<string, { readonly bundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-public-conformance-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime",
      platform: "browser", target: ["es2022"] });
    for (const [index, testCase] of successful.entries()) {
      const { definition, invocation } = scene(testCase.source);
      const parsed = parseComponent(definition, testCase.name);
      for (const mode of ["application", "library"] as const) {
        const caseDirectory = join(directory, String(index), mode);
        await mkdir(caseDirectory, { recursive: true });
        await writeFile(join(caseDirectory, "component.html"), definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode, target: "svelte", entries: ["component.html"], root: caseDirectory, outDirectory });
        assert.deepEqual(manifest.components.map((component) => component.tag), [parsed.contract.tag]);
        const component = manifest.components[0]!;
        const wrapper = join(outDirectory, "App.svelte");
        await writeFile(wrapper, `<script>import ${component.name} from "./${component.artifact}";</script>\n${consumer(invocation, parsed.contract.tag, component.name, parsed.contract.props)}`);
        const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
        const css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
        const browserEntry = join(outDirectory, "browser.ts");
        const bundle = join(outDirectory, "svelte.js");
        await writeFile(browserEntry, `import { mount, hydrate } from "svelte";\nimport App from "./App.svelte";\nconst target = document.querySelector("main")!;\nif (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
        await build({ entryPoints: [browserEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [nodeModules], plugins: [sveltePlugin("client")] });
        const serverEntry = join(outDirectory, "server.ts");
        const serverBundle = join(outDirectory, "server.mjs");
        await writeFile(serverEntry, `import { render } from "svelte/server";\nimport App from "./App.svelte";\nexport const html = render(App).body;`);
        await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
          packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
        const server = await import(pathToFileURL(serverBundle).href) as { html: string };
        artifacts.set(`${index}:${mode}`, { bundle, css, server: server.html });
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
            const [live, svelte, hydrated] = await Promise.all([browser.newPage({ viewport: { width: 800, height: 600 } }),
              browser.newPage({ viewport: { width: 800, height: 600 } }), browser.newPage({ viewport: { width: 800, height: 600 } })]);
            const errors: string[] = [];
            const warnings: string[] = [];
            try {
              const { definition, invocation } = scene(testCase.source);
              const output = artifacts.get(`${index}:${mode}`)!;
              for (const page of [live, svelte, hydrated]) page.on("pageerror", (error) => errors.push(error.message));
              hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await live.setContent(`${baseStyle}${definition}<main>${invocation}</main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
              await svelte.setContent(`${baseStyle}<style>${output.css}</style><main></main>`);
              await svelte.addScriptTag({ path: output.bundle });
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
              const requiresHydration = testCase.expect.probe.includes(".validity.");
              try {
                await svelte.waitForFunction(() => document.querySelector("main")?.childElementCount !== 0, undefined, { timeout: 3_000 });
              } catch (error) {
                assert.fail(`Svelte produced no root: ${String(error)}; errors=${errors.join(" | ")}; html=${await svelte.locator("main").innerHTML()}; server=${output.server}`);
              }
              const [liveResult, svelteResult, serverResult] = await Promise.all([
                live.evaluate((script) => Function(script)(), program),
                svelte.evaluate((script) => Function(script)(), program),
                requiresHydration ? Promise.resolve(undefined) : hydrated.evaluate((script) => Function(script)(), program),
              ]);
              assert.deepEqual(liveResult, testCase.expect.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(svelteResult), withoutStylingMarkers(liveResult), "public Svelte browser behavior differs");
              if (!requiresHydration) assert.deepEqual(withoutStylingMarkers(serverResult), withoutStylingMarkers(liveResult), "public Svelte server behavior differs");
              await assertPixelsEqual(svelte, await capturePixels(svelte), await capturePixels(live), "public Svelte rendered pixels differ", live);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Svelte server-rendered pixels differ", live);
              await hydrated.addScriptTag({ path: output.bundle });
              const hydratedResult = await hydrated.evaluate((script) => Function(script)(), program);
              assert.deepEqual(withoutStylingMarkers(hydratedResult), withoutStylingMarkers(liveResult), "public Svelte hydrated behavior differs");
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Svelte hydrated pixels differ", live);
              for (const step of testCase.expect.after ?? []) {
                await Promise.all([live, svelte, hydrated].map((page) => page.evaluate((action) => Function(action)(), step.action)));
                await Promise.all([live, svelte, hydrated].map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
                const [liveAfter, svelteAfter, hydratedAfter] = await Promise.all([live, svelte, hydrated].map((page) => page.evaluate((script) => Function(script)(), program)));
                assert.deepEqual(liveAfter, step.result, "live runtime changed after interaction");
                assert.deepEqual(withoutStylingMarkers(svelteAfter), withoutStylingMarkers(liveAfter), "Svelte browser behavior differs after interaction");
                assert.deepEqual(withoutStylingMarkers(hydratedAfter), withoutStylingMarkers(liveAfter), "Svelte hydrated behavior differs after interaction");
                await assertPixelsEqual(svelte, await capturePixels(svelte), await capturePixels(live), "Svelte pixels differ after interaction", live);
                await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "Svelte hydrated pixels differ after interaction", live);
              }
              assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), [], "Svelte reported a hydration mismatch");
              assert.deepEqual(errors, []);
            } finally {
              await Promise.all([live.close(), svelte.close(), hydrated.close()]);
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
