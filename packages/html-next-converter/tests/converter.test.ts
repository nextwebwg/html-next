import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { HtmlDiagnosticError } from "@nextwebwg/html-next";

import { cases as conformanceCases, type ConformanceCase, type DiagnosticExpect } from "../../html-next/tests/conformance/cases.js";

import {
  convertComponents,
  FrameworkConversionError,
  FrameworkDuplicateEntryError,
  FrameworkOutputCollisionError,
  FrameworkTargetVersionError,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "html-next-converter-"));
  temporary.push(root);
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article :aria-label="label"><slot></slot></article>
    <style>:host { display: block; }</style>
  </template>`);
  return root;
}

/** Compiles a converted SFC with Vue's own compiler, failing on any error. */
function compileVue(source: string, filename: string): void {
  const parsed = parseVue(source, { filename });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: filename, inlineTemplate: true });
  const template = compileTemplate({
    id: filename,
    filename,
    source: parsed.descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings ?? {} },
  });
  assert.deepEqual(template.errors, []);
}

describe("framework converter", () => {
  it("resolves exported package component subpaths from the consuming project", async () => {
    const root = await fixture();
    const packageRoot = join(root, "node_modules", "@acme", "ui");
    await mkdir(join(packageRoot, "components"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@acme/ui",
      exports: { "./*.html": "./components/*.html" },
    }));
    await writeFile(join(packageRoot, "components", "badge.html"),
      '<template component="x-badge" status="early" summary="Badge."><span>Badge</span></template>');
    await writeFile(join(root, "x-card.html"),
      '<link rel="component" href="@acme/ui/badge.html"><template component="x-card" status="early" summary="Card."><article><x-badge></x-badge></article></template>');

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `generated-${mode}`);
      const manifest = await convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory });
      assert.deepEqual(manifest.components.map(({ tag }) => tag).sort(), ["x-badge", "x-card"]);
      compileVue(await readFile(join(outDirectory, "vue", "XBadge.vue"), "utf8"), "XBadge.vue");
      compileVue(await readFile(join(outDirectory, "vue", "XCard.vue"), "utf8"), "XCard.vue");
    }
  });

  it("uses HTML parser recovery for duplicate attributes, as the browser does", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"),
      '<template component="x-card" status="early" summary="Card."><article class="first" class="second">Ready</article></template>');
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `recovered-${mode}`);
      await convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory });
      const source = await readFile(join(outDirectory, "vue", "XCard.vue"), "utf8");
      compileVue(source, "XCard.vue");
      assert.match(source, /class="first"/);
      assert.doesNotMatch(source, /class="second"/);
    }
  });

  it("reports unresolved package component subpaths at their importing definition", async () => {
    const root = await fixture();
    const packageRoot = join(root, "node_modules", "@acme", "ui");
    await mkdir(join(packageRoot, "components"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@acme/ui",
      exports: { "./badge.html": "./components/badge.html" },
    }));
    await writeFile(join(packageRoot, "components", "badge.html"),
      '<template component="x-badge" status="early" summary="Badge."><span>Badge</span></template>');
    for (const [name, specifier] of [["unexported", "@acme/ui/hidden.html"], ["missing", "@acme/missing/hidden.html"]] as const) {
      await writeFile(join(root, "x-card.html"),
        `<link rel="component" href="${specifier}"><template component="x-card" status="early" summary="Card."><article></article></template>`);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `generated-${name}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === "HL002" &&
            error.diagnostic.source?.endsWith("/x-card.html") === true,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
      }
    }
  });

  it("retains component-graph diagnostics without writing partial Vue output", async () => {
    const root = await fixture();
    const cases = [
      {
        name: "missing dependency",
        source: '<link rel="component" href="./missing.html"><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL009",
        sourceSuffix: "/missing.html",
      },
      {
        name: "dependency escapes package",
        source: '<link rel="component" href="../outside.html"><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL003",
        sourceSuffix: "/x-card.html",
      },
      {
        name: "controller escapes package",
        source: '<template component="x-card" status="early" summary="Card." controller="../outside.js"><article></article></template>',
        code: "HL005",
        sourceSuffix: "/x-card.html",
      },
      {
        name: "empty dependency URL",
        source: '<link rel="component" href=""><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL006",
        sourceSuffix: "/x-card.html",
      },
    ] as const;

    for (const testCase of cases) {
      await writeFile(join(root, "x-card.html"), testCase.source);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `generated-${testCase.code}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === testCase.code &&
            error.diagnostic.source?.endsWith(testCase.sourceSuffix) === true,
          `${mode}: ${testCase.name}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${mode}: ${testCase.name} wrote output`);
      }
    }
  });

  it("retains every static conformance diagnostic with its source and writes no output", async () => {
    const runtimeOnly = new Set([
      "HC020: a required prop is not provided",
      "HR001: two definitions declare the same tag",
      "HR002: a non-finite number prop invocation value",
    ]);
    const diagnostics = conformanceCases.filter((testCase): testCase is ConformanceCase & { readonly expect: DiagnosticExpect } =>
      "code" in testCase.expect);
    assert.equal(diagnostics.length, 29, "review new diagnostic cases for converter coverage");
    const staticDiagnostics = diagnostics.filter((testCase) => !runtimeOnly.has(testCase.name));
    assert.equal(staticDiagnostics.length, 26);
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-diagnostics-"));
    temporary.push(root);
    await mkdir(join(root, "components"));

    for (const [index, testCase] of staticDiagnostics.entries()) {
      const closing = testCase.source.lastIndexOf("</template>");
      assert.ok(closing >= 0, `${testCase.name} needs a component definition`);
      const entry = `components/invalid-${index}.html`;
      await writeFile(join(root, entry), testCase.source.slice(0, closing + "</template>".length));
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `out-${mode}-${index}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: [entry], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === testCase.expect.code &&
            error.diagnostic.source?.endsWith(entry) === true,
          `${mode}: ${testCase.name}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${mode}: ${testCase.name} wrote output`);
      }
    }
  });

  it("preserves additional parser diagnostics through both public Vue graph modes", async () => {
    const root = await fixture();
    const invalid = [
      { code: "HC022", body: '<template component="x-card" status="early" summary="Card." controller=""><article></article></template>' },
      { code: "HC023", body: '<template component="x-card" status="early" summary="Card."><defs><handler name="go"><set name="count"></set></handler></defs><article></article></template>' },
      { code: "HT017", body: '<template component="x-card" status="early" summary="Card."><article $match="oops"></article></template>' },
      { code: "HT019", body: '<template component="x-card" status="early" summary="Card."><article $ref="invalid name"></article></template>' },
      { code: "HT020", body: '<template component="x-card" status="early" summary="Card."><article style:1bad="true"></article></template>' },
      { code: "HY001", body: '<template component="x-card" status="early" summary="Card."><article></article><style>:host-state([missing]) { color: red; }</style></template>' },
      { code: "HY002", body: '<template component="x-card" status="early" summary="Card."><defs><state name="items" type="list(string)" :value="[]"></state></defs><article></article><style>:host-state([items]) { color: red; }</style></template>' },
      { code: "HY003", body: '<template component="x-card" status="early" summary="Card."><article></article><style>:scope { color: red; }</style></template>' },
    ] as const;

    for (const { code, body } of invalid) {
      await writeFile(join(root, "x-card.html"), body);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `invalid-${code}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === code &&
            error.diagnostic.source?.endsWith("/x-card.html") === true,
          `${mode}: ${code}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${mode}: ${code} wrote output`);
      }
    }
  });

  it("emits a Vue component with only its authored-feature helper", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["x-card.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCard.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.doesNotMatch(source, /html-next:nested-depth/, "ordinary graphs must not pay for the recursion guard");
    assert.deepEqual([...source.matchAll(/^import[^\n]*from ['"]([^'"]+)['"]/gm)].map((match) => match[1]).filter((from) => from !== "vue"), ["./props"]);
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "vue/props.ts" && artifact.kind === "helper"));
    assert.match(await readFile(join(outDirectory, "vue", "props.ts"), "utf8"), /function checkedProp/);
    assert.match(source, /<style scoped>\n\[data-component~="x-card"\] \{\n  display: block;\n\}/);
    assert.equal(manifest.graph, "application");
    assert.deepEqual(manifest.entries, [{ source: "x-card.html", tag: "x-card", artifact: "vue/XCard.vue" }]);
    assert.equal(manifest.output.entry, "vue/application.ts");
    assert.equal(manifest.output.inventory, "html-next.conversion.json");
    assert.equal(await readFile(join(outDirectory, "vue", "application.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("omits the typed-prop helper from a prop-free graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-no-props-"));
    temporary.push(root);
    await writeFile(join(root, "static.html"), '<template component="x-static" status="early" summary="Static."><p>Ready</p></template>');
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["static.html"], target: "vue", root, outDirectory });
    assert.equal(manifest.output.artifacts.some((artifact) => artifact.path === "vue/props.ts"), false);
    await assert.rejects(() => access(join(outDirectory, "vue", "props.ts")), { code: "ENOENT" });
  });

  it("maps state, computed values, handlers, and typed events to Vue", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-reactive-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <computed name="double" from="count * 2"></computed>
        <event name="count-change" type="number"></event>
        <handler name="increment">
          <set name="count" :value="count + 1"></set>
          <dispatch event="count-change" :value="count"></dispatch>
        </handler>
      </defs>
      <button :data-count="count" on:click="increment"><output $value="double"></output></button>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCounter.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.match(source, /from '\.\/host'/);
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "vue/host.ts"));
    assert.match(await readFile(join(outDirectory, "vue", "host.ts"), "utf8"), /function useComponentHost/);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.match(source, /const count = ref\(0\)\n/);
    assert.match(source, /const double = cycleCheckedComputed\(\(\) => count\.value \* 2\)\n/);
    assert.match(source, /function increment\(\): void \{\n  count\.value = count\.value \+ 1\n  dispatch\('count-change', count\.value\)\n/);
    assert.match(source, /const isCountChangeDetail = \(detail: unknown\): boolean =>\n  typeof detail === 'number' && Number\.isFinite\(detail\)/);
    assert.match(source, /:data-count="count"/);
  });

  it("keeps root-relative data requests on the browser origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-data-root-"));
    temporary.push(root);
    await writeFile(join(root, "feed.html"), `<template component="x-feed" status="early" summary="Feed."><defs>
      <data name="result" src="/api/feed" type="object({ label: string })"></data>
    </defs><output $value="result.value.label"></output></template>`);
    const outDirectory = join(root, "generated");
    await convertComponents({ mode: "application", entries: ["feed.html"], target: "vue", root, outDirectory });
    const source = await readFile(join(outDirectory, "vue", "XFeed.vue"), "utf8");

    compileVue(source, "XFeed.vue");
    assert.doesNotMatch(source, /file:\/\//);
    assert.match(source, /useDataRead\(result, \{\s+source: '\/api\/feed',\s+definition: '',/);
  });

  it("requires a public URL mapping for component-relative data requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-data-relative-"));
    temporary.push(root);
    await mkdir(join(root, "components"));
    await writeFile(join(root, "components", "feed.html"), `<template component="x-feed" status="early" summary="Feed."><defs>
      <data name="result" src="./api/feed" type="object({ label: string })"></data>
    </defs><output $value="result.value.label"></output></template>`);
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["components/feed.html"], target: "vue", root, outDirectory }),
      (error) => error instanceof FrameworkConversionError && error.message.includes("publicRootURL"),
    );
    await assert.rejects(() => access(outDirectory));

    await convertComponents({ mode: "application", entries: ["components/feed.html"], target: "vue", root, outDirectory, publicRootURL: "/app/" });
    const source = await readFile(join(outDirectory, "vue", "XFeed.vue"), "utf8");
    compileVue(source, "XFeed.vue");
    assert.doesNotMatch(source, /file:\/\//);
    assert.match(source, /useDataRead\(result, \{\s+source: '\.\/api\/feed',\s+definition: '\/app\/components\/feed\.html',/);
  });

  it("copies the controller beside the component and imports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "components", "x-toggle"), { recursive: true });
    await mkdir(join(root, "components", "shared"), { recursive: true });
    await writeFile(join(root, "components", "x-toggle", "x-toggle.html"), `<template component="x-toggle" status="early" summary="Toggle." controller="./x-toggle.js">
      <defs><state name="on" :value="false"></state></defs>
      <button type="button"><slot></slot></button>
    </template>`);
    await writeFile(join(root, "components", "x-toggle", "x-toggle.js"), 'import { flip } from "../shared/flip.js";\nexport default function controller(host) { const root = host.root; const onClick = () => { host.state.on = flip(host.state.on); }; root.addEventListener("click", onClick); return () => root.removeEventListener("click", onClick); }\n');
    await writeFile(join(root, "components", "shared", "flip.js"), "export const flip = (value) => !value;\n");
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["components/x-toggle/x-toggle.html"], target: "vue", root, outDirectory });
    const source = await readFile(join(outDirectory, "vue", "XToggle.vue"), "utf8");

    assert.match(source, /\(\) => import\('\.\/controllers\/x-toggle\/x-toggle\/x-toggle\.js'\)/);
    assert.equal(manifest.components[0]?.controller, "vue/controllers/x-toggle/x-toggle/x-toggle.js");
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "x-toggle", "x-toggle.js"));
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "shared", "flip.js"));
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => kind === "controller" && path.endsWith("shared/flip.js")));
  });

  it("reports missing and escaping controller resources at the component source without partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-diagnostics-"));
    temporary.push(root);
    await mkdir(join(root, "components"));
    const outside = await mkdtemp(join(tmpdir(), "html-next-converter-controller-outside-"));
    temporary.push(outside);
    await writeFile(join(outside, "secret.js"), "export const secret = true;\n");
    await symlink(join(outside, "secret.js"), join(root, "components", "linked.js"));
    const scenarios = [
      { name: "missing-controller", controller: "./missing.js", expected: "missing.js" },
      { name: "missing-import", controller: "./missing-import.js", module: 'import "./absent.js";\nexport default function controller() {}\n', expected: "absent.js" },
      { name: "escaping-import", controller: "./escaping-import.js", module: 'import "../../outside.js";\nexport default function controller() {}\n', expected: "outside the component's approved root" },
      { name: "symlink-import", controller: "./symlink-import.js", module: 'import "./linked.js";\nexport default function controller() {}\n', expected: "outside the component's approved root" },
    ] as const;
    for (const scenario of scenarios) {
      const entry = `components/${scenario.name}.html`;
      await writeFile(join(root, entry), `<template component="x-${scenario.name}" status="early" summary="Controller resource." controller="${scenario.controller}"><div></div></template>`);
      if ("module" in scenario) await writeFile(join(root, "components", `${scenario.name}.js`), scenario.module);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `${scenario.name}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: [entry], target: "vue", root, outDirectory }),
          (error) => error instanceof FrameworkConversionError && error.code === "HTC001" &&
            error.source === entry && error.tag === `x-${scenario.name}` && error.message.includes(scenario.expected),
          `${mode}: ${scenario.name}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
      }
    }
  });

  it("rejects unresolved dynamic controller imports before emitting relocated code", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-dynamic-"));
    temporary.push(root);
    await writeFile(join(root, "dynamic.html"), '<template component="x-dynamic" status="early" summary="Dynamic controller." controller="./dynamic.js"><div></div></template>');
    await writeFile(join(root, "dynamic.js"), 'const specifier = "./helper.js";\nexport default async function controller() { return import(specifier); }\n');
    await writeFile(join(root, "helper.js"), "export const value = 1;\n");
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, mode);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["dynamic.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof FrameworkConversionError && error.code === "HTC001" &&
          error.source === "dynamic.html" && error.tag === "x-dynamic" &&
          error.message.includes("dynamic import") && error.message.includes("dynamic.js"),
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  for (const mode of ["application", "library"] as const) {
    it(`rejects duplicate ${mode} roots before writing output`, async () => {
      const root = await fixture();
      const outDirectory = join(root, "generated");
      await assert.rejects(
        () => convertComponents({ mode, entries: ["x-card.html", "x-card.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof FrameworkDuplicateEntryError && error.code === "HTC002" && error.source === "x-card.html",
      );
      await assert.rejects(() => access(outDirectory));
    });
  }

  it("converts a real-element root $match through the public Vue converter", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs><prop name="as" type="keyword" values="a, b" default="a">Kind.</prop></defs>
      <section $match :data-as="as"><p $when="as = 'a'">A</p><p $else>B</p></section>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory });
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /<section[\s\S]*:data-as="reflectedProp\('as'/);
    assert.match(component, /<p v-if="checkedProps\.as === 'a'">A<\/p>/);
  });

  it("reports a source-located diagnostic for a guarded component root", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "guarded.html"), `<template component="x-guarded" status="early" summary="Guarded.">
      <defs><prop name="show" type="boolean" default="true">Visibility.</prop></defs>
      <section $if="show" :data-show="show">Visible</section>
    </template>`);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `generated-${mode}`);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["guarded.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT021" &&
          error.diagnostic.source?.endsWith("/guarded.html") === true,
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  it("emits the sanitizer helper only for converted components using $html", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-html-"));
    temporary.push(root);
    await writeFile(join(root, "markup.html"), `<template component="x-markup" status="early" summary="Safe markup.">
      <defs><prop name="body" type="string">Markup.</prop></defs>
      <article $html="body"></article>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["markup.html"], target: "vue", root, outDirectory });
    const component = await readFile(join(outDirectory, "vue", "XMarkup.vue"), "utf8");
    const helper = await readFile(join(outDirectory, "vue", "html.ts"), "utf8");
    compileVue(component, "XMarkup.vue");
    assert.match(component, /from '\.\/html'/);
    assert.match(helper, /from "parse5"/);
    assert.doesNotMatch(helper, /\.setHTML\(/);
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => path === "vue/html.ts" && kind === "helper"));
  });

  it("emits a stable public entry for a converted component library", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["x-card.html"], target: "vue", root, outDirectory });
    assert.equal(manifest.graph, "library");
    assert.equal(manifest.output.entry, "vue/index.ts");
    assert.equal(await readFile(join(outDirectory, "vue", "index.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("rejects colliding component names before writing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-collision-"));
    temporary.push(root);
    await writeFile(join(root, "x-a1.html"), '<template component="x-a1" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "x-a-1.html"), '<template component="x-a-1" status="early" summary="Second."><div></div></template>');
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "library", entries: ["x-a1.html", "x-a-1.html"], target: "vue", root, outDirectory }),
      (error) => error instanceof FrameworkOutputCollisionError && error.code === "HTC002" &&
        error.artifact === "vue/XA1.vue" && error.sources.includes("x-a1.html") && error.sources.includes("x-a-1.html"),
    );
    await assert.rejects(() => access(outDirectory));
  });

  it("retains the source-located graph diagnostic for duplicate component tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-duplicate-tag-"));
    temporary.push(root);
    await writeFile(join(root, "first.html"), '<template component="x-duplicate" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "second.html"), '<template component="x-duplicate" status="early" summary="Second."><span></span></template>');
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, mode);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["first.html", "second.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HL007" &&
          error.diagnostic.source?.endsWith("/second.html") === true,
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  it("guards a 34-component invocation chain but not the permitted 33-component chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-depth-"));
    temporary.push(root);
    for (const count of [33, 34]) {
      const entries: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const entry = `${count}/depth-${index}.html`;
        entries.push(entry);
        if (index === 0) await mkdir(join(root, String(count)));
        await writeFile(join(root, entry), `<template component="x-depth-${index}" status="early" summary="Depth ${index}."><section>${index + 1 < count ? `<x-depth-${index + 1}></x-depth-${index + 1}>` : "Done"}</section></template>`);
      }
      const outDirectory = join(root, `out-${count}`);
      const manifest = await convertComponents({ mode: "application", entries, target: "vue", root, outDirectory });
      assert.equal(manifest.components.length, count);
      const guarded = await readFile(join(outDirectory, "vue", "XDepth0.vue"), "utf8");
      assert.equal(guarded.includes("html-next:nested-depth"), count === 34);
    }
  });

  it("rejects unsupported target versions before loading or writing the graph", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["missing.html"], target: "vue", targetVersion: "2.7", root, outDirectory }),
      (error) => error instanceof FrameworkTargetVersionError && error.code === "HTC003" && error.supported === "3.5",
    );
    await assert.rejects(() => access(outDirectory));
  });
});
