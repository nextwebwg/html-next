import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, it } from "vitest";
import { build, createServer } from "vite";
import preact from "@preact/preset-vite";
import { chromium } from "playwright";
import htmlNext from "../src/vite.js";
import { syncHtmlNext } from "../src/framework.js";
import { installSourcePackage } from "./source-package.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);
const run = promisify(execFile);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const control = `<template component="ui-button"><defs>
  <prop name="label" type="string" required>Label.</prop>
  <state name="count" type="integer" value="0"></state>
  <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
  </defs><button on:click="increment">{$label}<output>{$count}</output><slot></slot></button>
  <style>:host { color: rgb(1, 2, 3); }</style></template>
  <template component="ui-unused"><aside>UNUSED_COMPONENT_MARKER</aside><style>:host { --unused-style: red; }</style></template>`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "html-next-preact-vite-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  for (const name of ["preact", "preact-render-to-string"]) {
    await symlink(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(root, "node_modules", name), "dir");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { "@example/controls": "1.0.0", preact: "11.1.0" } }));
  await installSourcePackage(root, { "components/button.html": control, "components/nested/label.html": '<template component="ui-label"><span>Nested</span></template>' });
  return root;
}

const plugins = () => [htmlNext({ target: "preact" }), preact()];

it("builds packed Preact source imports, local imports and checked declarations without React", async () => {
  const root = await fixture();
  await writeFile(join(root, "src", "local.html"), '<template component="ui-local"><span>Local</span></template>');
  await writeFile(join(root, "src", "server.tsx"), `import { renderToString } from "preact-render-to-string";
    import { UiButton } from "@example/controls"; import { UiLocal } from "./local.html";
    export const render = () => renderToString(<UiButton label="Save"><UiLocal /></UiButton>);`);
  await build({ root, configFile: false, logLevel: "silent", plugins: plugins(), build: { ssr: join(root, "src/server.tsx"), outDir: "dist" } });
  const server = await import(pathToFileURL(join(root, "dist/server.js")).href) as { render(): string };
  assert.match(server.render(), /Save.*<output>0<\/output>.*Local/s);
  const prepared = await syncHtmlNext({ root, target: "preact" });
  assert.match(await readFile(prepared.declarationsFile, "utf8"), /export const UiButton:/);
  await writeFile(join(root, "src", "consumer.tsx"), `import { UiButton } from "@example/controls";
    const good = <UiButton label="Save" ref={element => element?.focus()} />;
    // @ts-expect-error A label is required.
    const missing = <UiButton />;
    // @ts-expect-error A label must be a string.
    const bad = <UiButton label={42} />;
    void [good, missing, bad];`);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true,
    module: "ESNext", moduleResolution: "Bundler", target: "ES2022", jsx: "react-jsx", jsxImportSource: "preact",
    allowArbitraryExtensions: true, noEmit: true }, include: ["src"] }));
  try { await run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { cwd: root }); }
  catch (error) { assert.fail((error as { stdout?: string }).stdout ?? String(error)); }
  await writeFile(join(root, "src", "client.tsx"), `import { render } from "preact"; import { UiButton } from "@example/controls";
    render(<UiButton label="Save" />, document.body);`);
  const client = await build({ root, configFile: false, logLevel: "silent", plugins: plugins(),
    build: { rollupOptions: { input: join(root, "src/client.tsx") }, write: false, minify: false } });
  const results = Array.isArray(client) ? client : [client];
  const output = results.flatMap(result => "output" in result ? result.output : []);
  const content = output.map(item => item.type === "asset" ? String(item.source) : item.code).join("\n");
  assert.match(content, /rgb\(1, ?2, ?3\)/);
  assert.doesNotMatch(content, /UNUSED_COMPONENT_MARKER|--unused-style|react-dom/);
}, 60_000);

it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("hydrates a Vite Preact consumer in place and handles native clicks", async () => {
  const root = await fixture();
  await writeFile(join(root, "src", "server.tsx"), `import { renderToString } from "preact-render-to-string";
    import { UiButton } from "@example/controls"; export const render = () => renderToString(<UiButton label="Save" />);`);
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: plugins(), server: { host: "127.0.0.1", port: 0 } });
  const browser = await chromium.launch();
  try {
    await server.listen();
    const module = await server.ssrLoadModule("/src/server.tsx") as { render(): string };
    await writeFile(join(root, "src", "client.tsx"), `import { hydrate } from "preact"; import { UiButton } from "@example/controls";
      const before = document.querySelector("button"); hydrate(<UiButton label="Save" />, document.getElementById("app")!);
      document.body.dataset.retained = String(before === document.querySelector("button"));`);
    await writeFile(join(root, "index.html"), `<div id="app">${module.render()}</div><script type="module" src="/src/client.tsx"></script>`);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => document.body.dataset.retained === "true");
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "1");
    assert.equal(await page.locator("button").evaluate(element => getComputedStyle(element).color), "rgb(1, 2, 3)");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
}, 60_000);
