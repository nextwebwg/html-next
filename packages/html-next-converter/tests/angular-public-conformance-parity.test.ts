import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { parseComponent, parseTypeExpression, parseTypedValue, angularHostTag, type ComponentDefinition } from "@nextwebwg/html-next";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { cases } from "../../html-next/tests/conformance/cases.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
const baseStyle = "<base href=\"http://localhost/\"><style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>";
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

function consumer(invocation: string, definition: ComponentDefinition): string {
  const nodes = parseFragment(invocation).childNodes as readonly HtmlNode[];
  const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const render = (node: HtmlNode): string => {
    if (node.nodeName === "#text") return node.value ?? "";
    if (node.tagName === undefined) return "";
    const component = node.tagName === definition.contract.tag;
    const tag = component ? angularHostTag(definition, new Map([[definition.contract.tag, definition]])) : node.tagName;
    const attributes = (node.attrs ?? []).map(attribute => {
      const propName = component ? Object.keys(definition.contract.props).find(name => name.toLowerCase() === attribute.name) : undefined;
      if (propName === undefined) return `${attribute.name}="${escape(attribute.value)}"`;
      const type = definition.contract.props[propName]!.type;
      const normalized = typeof type === "string" ? parseTypeExpression(type) : type;
      const parsed = parseTypedValue(attribute.value, normalized, "$", "html");
      const value = attribute.value === "" && normalized.kind === "terminal" && normalized.name === "boolean" ? true : parsed.ok ? parsed.value : attribute.value;
      return `[${propName}]="${escape(parsed.ok ? JSON.stringify(value) : `$any(${JSON.stringify(value)})`)}"`;
    });
    if (component) {
      attributes.unshift(definition.contract.tag);
      // The shared corpus deliberately exercises invalid runtime inputs. Angular's
      // template checker is bypassed only at those inputs, retaining their values.
      for (const [name, prop] of Object.entries(definition.contract.props)) {
        if (prop.required && !(node.attrs ?? []).some(attribute => attribute.name === name.toLowerCase())) attributes.push(`[${name}]="$any(undefined)"`);
      }
    }
    return `<${tag} ${attributes.join(" ")}>${(node.childNodes ?? []).map(render).join("")}${["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tag) ? "" : `</${tag}>`}`;
  };
  return nodes.map(render).join("");
}

function withoutStylingMarkers(value: unknown, tag: string): unknown {
  if (Array.isArray(value)) return value.map(entry => withoutStylingMarkers(entry, tag));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "attributes" && Array.isArray(entry)
      ? entry.filter((attribute) => Array.isArray(attribute) &&
        typeof attribute[0] === "string" && ![tag, "component", "ngh", "ng-version", "ng-server-context", "data-hn", "data-slotted"].includes(attribute[0]) && !attribute[0].startsWith("data-hn-"))
      : withoutStylingMarkers(entry, tag),
  ]));
}

async function capturePixels(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.screenshot({ animations: "disabled" });
}

describe.skipIf(!enabled)("public Angular converter shared conformance parity", () => {
  let directory = "";
  let liveBundle = "";
  const artifacts = new Map<string, { readonly bundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-angular-public-conformance-"));
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    await symlink(nodeModulesPath, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const entries: { index: number; mode: "application" | "library"; outDirectory: string; css: string }[] = [];
    const files: string[] = [];
    for (const [index, testCase] of successful.entries()) {
      const { definition, invocation } = scene(testCase.source);
      const parsedDefinition = parseComponent(definition, testCase.name);
      for (const mode of ["application", "library"] as const) {
        const caseDirectory = join(directory, String(index), mode);
        await mkdir(caseDirectory, { recursive: true });
        await writeFile(join(caseDirectory, "component.html"), definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode, target: "angular", entries: ["component.html"], root: caseDirectory, outDirectory });
        assert.deepEqual(manifest.components.map(component => component.tag), [parsedDefinition.contract.tag]);
        const component = manifest.components[0]!;
        const template = consumer(invocation, parsedDefinition);
        const style = manifest.output.artifacts.find(artifact => artifact.kind === "style");
        const css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
        const app = join(outDirectory, "app.ts"); files.push(app);
        await writeFile(app, `import { Component } from "@angular/core";
import { ${component.name} } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
@Component({ selector: "main", standalone: true, preserveWhitespaces: true, imports: [${component.name}], template: ${JSON.stringify(template)} }) export class App {}`);
        entries.push({ index, mode, outDirectory, css });
      }
    }
    const config = join(directory, "tsconfig.json");
    await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, experimentalDecorators: true, rewriteRelativeImportExtensions: true, rootDir: directory, outDir: join(directory, "compiled"), types: [] },
      angularCompilerOptions: { strictTemplates: true }, files }));
    const require = createRequire(import.meta.url);
    const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
    try { await promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: directory, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
    for (const { index, mode, outDirectory, css } of entries) {
      const app = join(directory, "compiled", String(index), mode, "out/app.js");
      const browserEntry = join(outDirectory, "browser.ts");
      const bundle = join(outDirectory, "angular.js");
      await writeFile(browserEntry, `import "@angular/compiler";
import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
import { App } from ${JSON.stringify(app)};
bootstrapApplication(App, { providers: document.querySelector("main")?.hasAttribute("ngh") ? [provideClientHydration()] : [] }).then(() => { document.body.dataset.ready = "true"; });`);
      await build({ entryPoints: [browserEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(directory, `server-${index}-${mode}.mjs`);
      await writeFile(serverEntry, `import "@angular/compiler";
import { renderApplication, provideServerRendering } from "@angular/platform-server";
import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
import { App } from ${JSON.stringify(app)};
export const render = () => renderApplication(context => bootstrapApplication(App, { providers: [provideServerRendering(), provideClientHydration()] }, context),
{ document: '<html><head><base href="http://localhost/"></head><body>${baseStyle}<style>${css}</style><main></main></body></html>', url: 'http://localhost/', allowedHosts: ['localhost'] });`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" } });
      const server = await import(pathToFileURL(serverBundle).href) as { render(): Promise<string> };
      artifacts.set(`${index}:${mode}`, { bundle, css, server: await server.render() });
    }
  }, 240_000);

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
              const tag = parseComponent(definition, testCase.name).contract.tag;
              for (const page of [live, react, hydrated]) page.on("pageerror", (error) => errors.push(error.message));
              await live.setContent(`${baseStyle}${definition}<main>${invocation}</main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
              await react.setContent(`${baseStyle}<style>${output.css}</style><main></main>`);
              await react.addScriptTag({ path: output.bundle });
              await hydrated.setContent(output.server);
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
              await react.waitForFunction(() => document.body.dataset.ready === "true", undefined, { timeout: 5_000 }).catch(error => { throw new Error(`${String(error)}; page errors: ${errors.join("; ")}`); });
              const [liveResult, reactResult, serverResult] = await Promise.all([live.evaluate((script) => Function(script)(), program),
                react.evaluate((script) => Function(script)(), program),
                requiresHydration ? Promise.resolve(undefined) : hydrated.evaluate((script) => Function(script)(), program)]);
              assert.deepEqual(liveResult, testCase.expect.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(reactResult, tag), withoutStylingMarkers(liveResult, tag), "public Angular browser behavior differs");
              if (!requiresHydration) assert.deepEqual(withoutStylingMarkers(serverResult, tag), withoutStylingMarkers(liveResult, tag), "public Angular server behavior differs");
              await assertPixelsEqual(react, await capturePixels(react), await capturePixels(live), "public Angular rendered pixels differ", live);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Angular server-rendered pixels differ", live);
              await hydrated.addScriptTag({ path: output.bundle });
              await hydrated.waitForFunction(() => document.body.dataset.ready === "true", undefined, { timeout: 5_000 }).catch(error => { throw new Error(`${String(error)}; page errors: ${errors.join("; ")}`); });
              if (requiresHydration) await hydrated.waitForFunction((script) => {
                try { Function(script)(); return true; } catch { return false; }
              }, program);
              const hydratedResult = await hydrated.evaluate((script) => Function(script)(), program);
              assert.deepEqual(withoutStylingMarkers(hydratedResult, tag), withoutStylingMarkers(liveResult, tag), "public Angular hydrated behavior differs");
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Angular hydrated pixels differ", live);
              for (const step of testCase.expect.after ?? []) {
                await Promise.all([live, react, hydrated].map((page) => page.evaluate((action) => Function(action)(), step.action)));
                await Promise.all([live, react, hydrated].map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
                const [liveAfter, reactAfter, hydratedAfter] = await Promise.all([live, react, hydrated].map((page) => page.evaluate((script) => Function(script)(), program)));
                assert.deepEqual(liveAfter, step.result, "live runtime changed after interaction");
                assert.deepEqual(withoutStylingMarkers(reactAfter, tag), withoutStylingMarkers(liveAfter, tag), "Angular browser behavior differs after interaction");
                assert.deepEqual(withoutStylingMarkers(hydratedAfter, tag), withoutStylingMarkers(liveAfter, tag), "Angular hydrated behavior differs after interaction");
                await assertPixelsEqual(react, await capturePixels(react), await capturePixels(live), "Angular pixels differ after interaction", live);
                await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "Angular hydrated pixels differ after interaction", live);
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
