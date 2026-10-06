import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { build } from "vite";
import { convertComponents } from "@nextwebwg/html-next-converter";

import { checkHtmlNext, componentsModule, htmlNext } from "../src/index.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "html-next-check-"));
  temporary.push(root);
  await writeFile(join(root, "package.json"), "{}");
  return root;
}

describe("checkHtmlNext", () => {
  it.each(["native", "vue", "react", "svelte"] as const)("collects independent declaration and expression failures for %s", async (target) => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app">
  <defs>
    <prop name="age" type="integer" default="wrong">Age.</prop>
    <prop name="enabled" type="boolean" default="wrong">Enabled.</prop>
    <prop name="label" type="not-a-type">Label.</prop>
  </defs>
  <main>
    <output $value="missingOne"></output>
    <output $value="missingTwo"></output>
    <output $value="age"></output>
  </main>
</template>`);
    const before = await readdir(root);
    const diagnostics = await checkHtmlNext({ target, root, entries: ["app.html"], mode: "application" });
    assert.deepEqual(diagnostics.map(({ code, line }) => [code, line]), [
      ["HC015", 3], ["HC015", 4], ["HC013", 5], ["HT003", 8], ["HT003", 9],
    ]);
    assert.deepEqual(await readdir(root), before);
  });

  it("continues across linked resources and multiple component carriers without repeating shared failures", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<link rel="component" href="./shared.html"><link rel="component" href="./other.html"><template component="x-app"><main></main></template>');
    await writeFile(join(root, "shared.html"), `<template component="x-one"><defs><prop name="a" type="integer" default="no">A.</prop></defs><main></main></template>
<template component="x-two"><defs><prop name="b" type="boolean" default="no">B.</prop></defs><main></main></template>`);
    await writeFile(join(root, "other.html"), '<link rel="component" href="./shared.html"><template component="x-other"><output $value="unknown"></output></template>');
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html", "other.html"] });
    assert.equal(diagnostics.length, 3);
    assert.equal(diagnostics.filter(({ code }) => code === "HC015").length, 2);
    assert.equal(diagnostics.filter(({ code }) => code === "HT003").length, 1);
  });

  it("collects invalid state types, initial values, and computed expressions", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app"><defs>
  <state name="age" type="integer" value="wrong"></state>
  <state name="enabled" type="boolean" value="wrong"></state>
  <state name="unknown" type="not-a-type"></state>
  <computed name="first" from="missingOne"></computed>
  <computed name="second" from="missingTwo"></computed>
</defs><main><output $value="age"></output></main></template>`);
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code, line }) => [code, line]), [
      ["HC013", 2], ["HC013", 3], ["HC013", 4], ["HT003", 5], ["HT003", 6],
    ]);
  });

  it("collects several native lowering failures within one component", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app"><main>
  <x-missing-one></x-missing-one>
  <x-missing-two></x-missing-two>
</main></template>`);
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code, line }) => [code, line]), [["HN001", 2], ["HN001", 3]]);
  });

  it("reports separate cycles without marking their acyclic parent as cyclic", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<link rel="component" href="./one.html"><link rel="component" href="./two.html"><template component="x-app"><main><x-one></x-one><x-two></x-two></main></template>');
    await writeFile(join(root, "one.html"), '<template component="x-one"><main><x-one></x-one></main></template>');
    await writeFile(join(root, "two.html"), '<template component="x-two"><main><x-two></x-two></main></template>');
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code, source }) => [code, source?.split("/").at(-1)]), [["HN002", "one.html"], ["HN002", "two.html"]]);
  });

  it("checks dependencies even when their importing component has a parse error", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<link rel="component" href="./child.html"><template component="x-app"><output $value="unknownParent"></output></template>');
    await writeFile(join(root, "child.html"), '<template component="x-child"><output $value="unknownChild"></output></template>');
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code, source }) => [code, source?.split("/").at(-1)]), [["HT003", "app.html"], ["HT003", "child.html"]]);
  });

  it("does not report a broken match arm as an additional malformed match", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app"><template $match>
  <main $when="missing">First</main>
  <main $else>Last</main>
</template></template>`);
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code }) => code), ["HT003"]);
  });

  it("reserves invalid names in legacy props groups without reporting extra binding errors", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app"><props>
  <prop name="age" type="integer" default="wrong">Age.</prop>
  <prop name="enabled" type="boolean" default="wrong">Enabled.</prop>
</props><main><output $value="age" from:data-age="age"></output><output $value="enabled" from:data-enabled="enabled"></output></main></template>`);
    const diagnostics = await checkHtmlNext({ root, entries: ["app.html"] });
    assert.deepEqual(diagnostics.map(({ code }) => code), ["HC015", "HC015"]);
  });

  it.each(["vue", "react", "svelte"] as const)("collects %s backend failures across valid components", async (target) => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<template component="x-app" controller="./missing-one.js"><main></main></template>');
    await writeFile(join(root, "other.html"), '<template component="x-other" controller="./missing-two.js"><main></main></template>');
    const diagnostics = await checkHtmlNext({ target, root, entries: ["*.html"], mode: "library" });
    assert.deepEqual(diagnostics.map(({ code, source }) => [code, source]), [["HTC001", "app.html"], ["HTC001", "other.html"]]);
  });

  it.each(["native", "vue", "react", "svelte"] as const)("checks %s without output or controller execution", async (target) => {
    const root = await fixture();
    await writeFile(join(root, "card.html"), `<template component="x-card"><defs><prop name="label" type="string" default="Ready">Label.</prop></defs><output $value="label"></output></template>`);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./card.html"><template component="x-app"><main><x-card></x-card></main></template>`);
    const before = await readdir(root, { recursive: true });
    assert.deepEqual(await checkHtmlNext({ target, entries: ["app.html"], mode: "application", root }), []);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
    // A controller must be read as source, never executed while checking.
    await writeFile(join(root, "controller.js"), 'throw new Error("Controller was executed"); export default () => {};');
    await writeFile(join(root, "app.html"), `<template component="x-app" controller="./controller.js"><main>Ready</main></template>`);
    assert.deepEqual(await checkHtmlNext({ target, entries: ["*.html"], mode: "library", root }), []);
  });

  it("returns the same native diagnostic as a Vite build, including its source", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<template component="x-app">\n  <main>\n    <x-missing></x-missing>\n  </main>\n</template>');
    const diagnostics = await checkHtmlNext({ entries: ["app.html"], root });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "HN001");
    assert.equal(diagnostics[0]?.severity, "error");
    assert.equal(diagnostics[0]?.line, 3);
    assert.equal(diagnostics[0]?.column, 5);
    assert.match(diagnostics[0]?.source ?? "", /app\.html$/);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);
    await assert.rejects(() => build({ root, logLevel: "silent", plugins: [htmlNext.vite({ entries: ["app.html"] })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"] } },
    }), (error: unknown) => error instanceof Error && error.message.includes(diagnostics[0]!.message));
    assert.deepEqual(await checkHtmlNext({ entries: ["app.html"], root,
      dynamicBoundaries: [{ tag: "x-missing", strategy: "external-custom-element" }] }), []);
  });

  it.each(["vue", "react", "svelte"] as const)("preserves %s conversion diagnostics", async (target) => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), `<template component="x-app" controller="./missing.js"><main></main></template>`);
    const options = { entries: ["app.html"], target, mode: "library" as const, root };
    const diagnostics = await checkHtmlNext(options);
    assert.equal(diagnostics[0]?.code, "HTC001");
    assert.equal(diagnostics[0]?.source, "app.html");
    await assert.rejects(() => convertComponents({ ...options, outDirectory: join(root, "output") }),
      (error: unknown) => error instanceof Error && error.message === diagnostics[0]?.message);
    assert.deepEqual((await readdir(root)).sort(), ["app.html", "package.json"]);
  });

  it("reports authored constraint errors in linked sources", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<link rel="component" href="./child.html"><template component="x-app"><main></main></template>');
    await writeFile(join(root, "child.html"), '<template component="x-child">\n  <defs>\n    <prop name="age" type="integer" min="soon">Age.</prop>\n  </defs>\n  <output $value="age"></output>\n</template>');
    const diagnostics = await checkHtmlNext({ entries: ["app.html"], root });
    assert.equal(diagnostics[0]?.code, "HC013");
    assert.equal(diagnostics[0]?.line, 3);
    assert.equal(diagnostics[0]?.column, 5);
    assert.match(diagnostics[0]?.source ?? "", /child\.html$/);
  });

  it("locates malformed expressions and invalid resource elements without adding fields to the AST", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.html"), '<template component="x-app">\n  <main>\n    <output $value="undeclared"></output>\n  </main>\n</template>');
    const expression = await checkHtmlNext({ entries: ["app.html"], root });
    assert.equal(expression[0]?.code, "HT003");
    assert.equal(expression[0]?.line, 3);
    assert.equal(expression[0]?.column, 5);
    await writeFile(join(root, "app.html"), '\n\n  <div>Invalid resource</div>');
    const resource = await checkHtmlNext({ entries: ["app.html"], root });
    assert.equal(resource[0]?.code, "HT009");
    assert.equal(resource[0]?.line, 3);
    assert.equal(resource[0]?.column, 3);
  });

  it("rejects operational failures rather than reporting a clean check", async () => {
    const root = await fixture();
    const diagnostics = await checkHtmlNext({ entries: ["missing.html"], root });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!.message, /ENOENT/);
    await assert.rejects(() => checkHtmlNext({ entries: ["missing/**/*.html"], root }), /matched no HTML/);
  });
});
