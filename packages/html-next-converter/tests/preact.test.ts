import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, it } from "vitest";
import { build } from "esbuild";
import { createElement, type ComponentType } from "preact";
import { renderToString } from "preact-render-to-string";
import { parseFragment } from "parse5";
import { cases } from "../../html-next/tests/conformance/cases.js";
import { convertComponents } from "../src/index.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

for (const mode of ["application", "library"] as const) it(`converts a typed ${mode} graph for Preact without React installed`, async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-preact-"));
  roots.push(root);
  await mkdir(join(root, "node_modules"));
  for (const name of ["preact", "preact-render-to-string", "parse5"]) {
    await symlink(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(root, "node_modules", name), "dir");
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "badge.html"), `<template component="x-badge"><defs><context name="count" from="x-card" as="inherited"></context></defs><aside>{$inherited}</aside></template>`);
  await writeFile(join(root, "card.js"), 'export function connect() { throw new Error("Browser connections must not run during SSR"); }');
  await writeFile(join(root, "card.html"), `<link rel="component" href="./badge.html"><template component="x-card" module="./card.js"><defs>
    <prop name="label" type="string" required>Label.</prop>
    <state name="count" type="integer" value="0"></state>
    <state name="body" type="string" value="&lt;b&gt;Safe&lt;/b&gt;"></state>
    <computed name="double" type="integer" from="$count * 2"></computed>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
    </defs><article><button on:click="increment">{$label}: {$double}</button><slot></slot><x-badge></x-badge><div $html="$body"></div></article>
    <style>:host { color: red; }</style></template>`);
  const output = join(root, "output");
  const manifest = await convertComponents({ target: "preact", mode, entries: ["card.html"], root, outDirectory: output });
  assert.equal(manifest.targetVersion, "11.1.0");
  assert.deepEqual(manifest.package.peerDependencies, { preact: "^11.1.0" });
  assert.equal(manifest.output.entry, `preact/${mode === "library" ? "index" : "application"}.ts`);
  for (const artifact of manifest.output.artifacts.filter(file => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) {
    const content = await readFile(join(output, artifact.path), "utf8");
    assert.doesNotMatch(content, /from ["']react(?:\/[^"']*)?["']/);
    if (artifact.path.endsWith(".tsx")) assert.match(content, /@jsxImportSource preact/);
  }
  const consumer = join(output, "consumer.tsx");
  await writeFile(consumer, `/** @jsxImportSource preact */
    import { XCard } from "./${manifest.output.entry}";
    const good = <XCard label="Save" ref={element => { element?.focus(); }}><b>Body</b></XCard>;
    // @ts-expect-error label is required
    const missing = <XCard />;
    // @ts-expect-error label must be a string
    const invalid = <XCard label={42} />;
    void [good, missing, invalid];`);
  try {
    await promisify(execFile)(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--jsx", "react-jsx", "--module", "preserve", "--moduleResolution", "bundler", "--target", "ES2022", "--allowImportingTsExtensions", consumer], { cwd: root });
  } catch (error) { assert.fail((error as { stdout?: string }).stdout ?? String(error)); }
  const bundle = join(output, "server.mjs");
  await build({ entryPoints: [join(output, manifest.output.entry)], outfile: bundle, bundle: true, platform: "node", format: "esm",
    packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
  const components = await import(pathToFileURL(bundle).href) as { XCard: ComponentType<{ label: string }> };
  assert.match(renderToString(createElement(components.XCard, { label: "Save" }, createElement("b", null, "Body"))), /Save:.*0.*<b[^>]*>Body<\/b>/s);
  assert.match(renderToString(createElement(components.XCard, { label: "Save" })), /<aside[^>]*>0<\/aside>.*<div><b>Safe<\/b><\/div>/s);
});

it("typechecks the shared conformance corpus using Preact's public types", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-preact-types-"));
  roots.push(root);
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  const files: string[] = [];
  for (const [index, testCase] of cases.filter(testCase => "probe" in testCase.expect).entries()) {
    const nodes = parseFragment(testCase.source, { sourceCodeLocationInfo: true }).childNodes;
    const carrier = nodes.find(node => node.nodeName === "template" && "attrs" in node && node.attrs.some(attribute => attribute.name === "component"));
    assert.ok(carrier?.sourceCodeLocation, testCase.name);
    const entry = `case-${index}.html`;
    await writeFile(join(root, entry), testCase.source.slice(carrier.sourceCodeLocation.startOffset, carrier.sourceCodeLocation.endOffset));
    const output = join(root, `out-${index}`);
    const manifest = await convertComponents({ target: "preact", mode: "library", entries: [entry], root, outDirectory: output });
    files.push(join(output, manifest.output.entry));
  }
  const config = join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
    jsx: "react-jsx", module: "Preserve", moduleResolution: "Bundler", target: "ES2022", types: [] }, files }));
  try { await promisify(execFile)(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", config], { cwd: root }); }
  catch (error) { assert.fail((error as { stdout?: string }).stdout ?? String(error)); }
}, 60_000);
