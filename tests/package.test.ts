import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const repositoryLicense = readFileSync(join(root, "LICENSE"), "utf8");
const workspace = mkdtempSync(join(tmpdir(), "html-next-package-consumer-"));
const useCommandShell = process.platform === "win32";
const componentsPackage = "@nextwebwg/html-next";
const releaseDirectories = ["html-next", "html-next-converter", "html-next-unplugin"] as const;
const publicExports = [
  ".",
  "./runtime",
  "./live",
  "./generated-runtime",
  "./inputs",
  "./bindings",
  "./forms",
  "./validation",
  "./browser",
  "./node-loader",
  "./server",
] as const;
const browserExports = [
  "./runtime",
  "./live",
  "./generated-runtime",
  "./inputs",
  "./bindings",
  "./forms",
  "./validation",
  "./browser",
] as const;

const selectedPackage = process.env.HTMLNEXT_PACKAGE_TEST;
if (selectedPackage && !releaseDirectories.some((directory) => directory === selectedPackage)) {
  throw new Error(`Unknown package test selection: ${selectedPackage}`);
}
const includesPackage = (...directories: string[]): boolean => !selectedPackage || directories.includes(selectedPackage);

// Removing the installed consumers on Windows can outlast the default hook budget.
afterAll(() => rmSync(workspace, { recursive: true, force: true }), 60_000);

const tarballs = new Map<string, string>();

function pack(packageDirectory: string): string {
  const existing = tarballs.get(packageDirectory);
  if (existing !== undefined) return existing;
  const packageRoot = join(root, "packages", packageDirectory);
  const packed = execFileSync(
    "corepack",
    ["pnpm", "pack", "--pack-destination", workspace],
    { cwd: packageRoot, encoding: "utf8", shell: useCommandShell },
  )
    .trim()
    .split("\n")
    .at(-1);

  expect(packed).toBeDefined();
  const file = isAbsolute(packed!) ? packed! : join(workspace, packed!);
  tarballs.set(packageDirectory, file);
  return file;
}

// Runs an installed bin the way a consumer does: through npm's node_modules/.bin link (a command shim on Windows).
function runBin(consumer: string, name: string, args: readonly string[] = []): string {
  const bin = join(consumer, "node_modules/.bin", useCommandShell ? `${name}.cmd` : name);
  if (!useCommandShell) expect(lstatSync(bin).isSymbolicLink()).toBe(true);
  return execFileSync(bin, args, { cwd: consumer, encoding: "utf8", shell: useCommandShell });
}

function specifier(path: typeof publicExports[number]): string {
  return path === "." ? componentsPackage : `${componentsPackage}/${path.slice(2)}`;
}

describe("workspace package contracts", () => {
  it.skipIf(!includesPackage("html-next"))("installs HTML Next with every public export", () => {
    const componentsTarball = pack("html-next");
    const consumer = join(workspace, "html-next-consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "package-consumer", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        componentsTarball,
      ],
      { cwd: consumer, shell: useCommandShell },
    );

    const installedRoot = join(
      consumer,
      "node_modules",
      "@nextwebwg",
      "html-next",
    );
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
      version: string;
      private?: boolean;
      license?: string;
      dependencies?: Record<string, string>;
      exports: Record<string, { types: string; import: string }>;
      repository?: { type: string; url: string; directory: string };
      publishConfig?: { access: string; tag: string; registry: string };
    };
    const sourceManifest = JSON.parse(readFileSync(join(root, "packages/html-next/package.json"), "utf8")) as { version: string };
    expect(manifest.version).toBe(sourceManifest.version);
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/nextwebwg/html-next.git",
      directory: "packages/html-next",
    });
    expect(manifest.publishConfig).toEqual({
      access: "public",
      tag: "latest",
      registry: "https://registry.npmjs.org/",
    });
    expect(readFileSync(join(installedRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    const benchmarkDependencies = [
      "reactive-framework-test-suite", "alien-signals", "anod", "s-js", "signal-polyfill",
      "@amadeus-it-group/tansu", "@angular/core", "@preact/signals-core", "@reactively/core",
      "@reatom/core", "@solidjs/signals", "@vue/reactivity", "mobx", "pota", "solid-js", "svelte",
    ];
    for (const name of benchmarkDependencies) {
      expect(manifest.dependencies?.[name], `${name} must remain dev-only`).toBeUndefined();
      expect(existsSync(join(consumer, "node_modules", name)), `${name} must not be installed for consumers`).toBe(false);
    }
    const packedFiles = readdirSync(installedRoot, { recursive: true }).map(String);
    expect(packedFiles.some((file) => /(?:^|[/\\])(?:scripts|tests|benchmarks)(?:[/\\]|$)|reactivity-(?:benchmark|matrix|regression)/.test(file)),
      "Published files must exclude benchmark runners, adapters, reports, and tests").toBe(false);
    expect(Object.keys(manifest.exports)).toEqual(publicExports);
    for (const path of publicExports) {
      const entry = manifest.exports[path]!;
      expect(existsSync(join(installedRoot, entry.import))).toBe(true);
      expect(existsSync(join(installedRoot, entry.types))).toBe(true);
    }
    const nodeEntry = join(consumer, "node-exports.mjs");
    writeFileSync(join(consumer, "prepare.mjs"), `import { bindModule } from "@nextwebwg/html-next/bindings";
export async function prepare({ document, host, flush, signal, data }) {
  const binding = bindModule({ props: { product: { input: () => data.product, load: value => Promise.resolve(value) } },
    connect() { throw new Error("Packaged SSR connected browser behavior"); } });
  const scope = await binding.prepare(host(document.querySelector('#prepared')), { phase: 'request', signal, source: 'installed' });
  await flush();
  return () => scope.dispose();
}
`);
    writeFileSync(
      nodeEntry,
      `${publicExports
        .filter((path) => path !== "./browser")
        .map((path) => `import ${JSON.stringify(specifier(path))};`)
        .join("\n")}
const { renderComponents, createRenderer } = await import("@nextwebwg/html-next/server");
const { parseComponent, add, subtract, multiply, divide } = await import("@nextwebwg/html-next");
const compiled = await import("@nextwebwg/html-next/generated-runtime");
const { createInputPort, INPUT_PORT, componentInputs } = await import("@nextwebwg/html-next/inputs");
let packedValue = 1;
const inputPort = createInputPort({ names: ["value"], read: () => packedValue,
  status: () => ({ ready: true, pending: false, error: null, stale: false }), supplied: () => false,
  publish(_name, input) { if (typeof input.value !== "number") return false; packedValue = input.value; return true; },
  untracked: run => run(), watch: run => { const cleanup = run(); return () => cleanup?.(); } });
const inputSource = componentInputs({ props: {}, [INPUT_PORT]: inputPort }).source("value");
if (!inputSource.publish({ value: 2, status: inputPort.status("value") }) || inputPort.read("value") !== 2) throw new Error("Packaged input-port adapter failed");
inputSource.dispose();
if (inputSource.publish({ value: 3, status: inputPort.status("value") })) throw new Error("Disposed packaged input source still writes");
if (add(1.1, 0.1) !== 1.2 || subtract(0.3, 0.1) !== 0.2 || multiply(0.1, 0.2) !== 0.02 || divide(1, 4) !== 0.25 || compiled.add !== add || compiled.remainder(0.3, 0.1) !== 0) throw new Error("Packaged decimal arithmetic failed");
const rendered = await renderComponents("<x-packed>Package SSR</x-packed>", { definitions: [parseComponent('<template component="x-packed"><p><slot></slot></p></template>')] });
if (!rendered.html.includes('component="x-packed"') || !rendered.html.includes("Package SSR")) throw new Error("Packaged server rendering failed");
const prepared = await renderComponents('<x-prepared id="prepared"></x-prepared>', {
  definitions: [parseComponent('<template component="x-prepared"><defs><prop name="product" type="string">Product.</prop><state name="draft" type="string" from="$product"></state></defs><p $attributes>{$draft}</p></template>')],
  prepare: { module: new URL('./prepare.mjs', import.meta.url).href, data: { product: 'Installed preparation' } }
});
if (!prepared.html.includes('<p') || !prepared.html.includes('>Installed preparation</p>')) throw new Error('Packaged preparation failed');
const owner = createRenderer({ workers: 1 });
try {
  owner.setWorkers(2);
  const scoped = await owner.render('<x-prepared id="prepared"></x-prepared>', {
    definitions: [parseComponent('<template component="x-prepared"><defs><prop name="product" type="string">Product.</prop></defs><p $attributes>{$product}</p></template>')],
    prepare: { module: new URL('./prepare.mjs', import.meta.url).href, data: { product: 'Owned preparation' } }
  });
  if (!scoped.html.includes('>Owned preparation</p>')) throw new Error('Packaged renderer ownership failed');
} finally { await owner.close(); }
process.stdout.write("ok");
`,
    );
    expect(
      execFileSync(process.execPath, [nodeEntry], { cwd: consumer, encoding: "utf8" }),
    ).toBe("ok");

    const typeEntry = join(consumer, "public-exports.ts");
    writeFileSync(
      typeEntry,
      `${publicExports.map((path, index) =>
        `import * as publicExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${publicExports.map((_, index) => `publicExport${index}`).join(", ")}];\n` +
      'import type { ServerPreparation, ServerPreparationContext, ServerRenderOptions, ServerRenderer } from "@nextwebwg/html-next/server";\n' +
      'export const preparation: ServerPreparation = async (context: ServerPreparationContext) => { await context.flush(); return () => { context.port?.close(); }; };\n' +
      'export const renderOptions: ServerRenderOptions = { definitions: [], signal: new AbortController().signal, prepare: { module: "file:///prepare.mjs", data: { value: 1 } } };\n' +
      'export function closeRenderer(renderer: ServerRenderer) { renderer.setWorkers(1); return renderer.close(); }\n' +
      'import { bindModule, type BindingAdoption } from "@nextwebwg/html-next/bindings";\n' +
      'export function adoptBindings(host: { props: object }, adoption: BindingAdoption) { bindModule({}).adopt(host, adoption); }\n' +
      'import { createInputPort, INPUT_PORT, type InputPortAdapter } from "@nextwebwg/html-next/inputs";\n' +
      'export function inputHost(adapter: InputPortAdapter) { return { props: {}, [INPUT_PORT]: createInputPort(adapter) }; }\n',
    );
    execFileSync(
      "corepack",
      [
        "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
        "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", typeEntry,
      ],
      { cwd: root, shell: useCommandShell },
    );
    const sdkEntry = join(consumer, "input-driver.ts");
    const sdkMeta = join(consumer, "input-driver-meta.json");
    writeFileSync(sdkEntry, 'import { componentInputs } from "@nextwebwg/html-next/inputs"; export { componentInputs };\n');
    execFileSync("corepack", ["pnpm", "--filter", componentsPackage, "exec", "esbuild", sdkEntry,
      "--bundle", "--platform=browser", `--outfile=${join(consumer, "input-driver.js")}`, `--metafile=${sdkMeta}`],
      { cwd: root, shell: useCommandShell });
    const sdkModules = Object.keys((JSON.parse(readFileSync(sdkMeta, "utf8")) as { inputs: Record<string, unknown> }).inputs)
      .filter(path => path.includes("/html-next/dist/"));
    expect(sdkModules.map(path => path.slice(path.lastIndexOf("/dist/") + 6)).sort()).toEqual(["component-inputs.js", "inputs.js"]);
    const providerEntry = join(consumer, "binding-driver.ts");
    const providerBundle = join(consumer, "binding-driver.js");
    const providerMeta = join(consumer, "binding-driver-meta.json");
    writeFileSync(providerEntry, 'export { BindingScope, bindModule } from "@nextwebwg/html-next/bindings";\n');
    execFileSync("corepack", ["pnpm", "--filter", componentsPackage, "exec", "esbuild", providerEntry,
      "--bundle", "--format=esm", "--platform=browser", `--outfile=${providerBundle}`, `--metafile=${providerMeta}`], { cwd: root, shell: useCommandShell });
    expect(readFileSync(providerBundle, "utf8")).not.toMatch(/compileExpression|parseTypedValue|ReactiveScope|parseComponentNodes|jsdom|worker_threads/);
    const providerModules = Object.keys((JSON.parse(readFileSync(providerMeta, "utf8")) as { inputs: Record<string, unknown> }).inputs);
    expect(providerModules.filter(path => /\/(?:expression|expression-parser|source-parser|parser|runtime)\.js$/.test(path))).toEqual([]);
    const browserEntry = join(consumer, "browser-exports.ts");
    writeFileSync(
      browserEntry,
      `${browserExports.map((path, index) =>
        `import * as browserExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${browserExports.map((_, index) => `browserExport${index}`).join(", ")}];\n`,
    );
    execFileSync(
      "corepack",
      [
        "pnpm", "--filter", componentsPackage, "exec", "esbuild", browserEntry, "--bundle", "--platform=browser",
        `--outfile=${join(consumer, "public-exports.js")}`,
      ],
      { cwd: root, shell: useCommandShell },
    );
  }, 240_000); // Windows runners have taken over 120 s for this install and bundle.

  it.skipIf(!includesPackage("html-next-converter", "html-next-unplugin"))("installs the source adapter and prepares React types through the consumer Vite config", () => {
    const tarballs = ["html-next", "html-next-converter", "html-next-unplugin"].map(pack);
    const consumer = join(workspace, "adapter-consumer");
    mkdirSync(join(consumer, "src"), { recursive: true });
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "adapter-consumer", private: true, type: "module" }));
    const toolingModules = join(root, "packages/html-next-unplugin/node_modules");
    const version = (name: string) => (JSON.parse(readFileSync(join(toolingModules, name, "package.json"), "utf8")) as { version: string }).version;
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs,
      ...["vite", "react", "react-dom", "@types/react", "@types/react-dom", "@vitejs/plugin-react"].map((name) => `${name}@${version(name)}`)],
      { cwd: consumer, shell: useCommandShell });
    const library = join(consumer, "node_modules", "@example", "source-controls");
    const source = join(consumer, "controls.html");
    writeFileSync(source, `<template component="ui-label" status="early" summary="Label."><defs><prop name="label" type="string" required>Label.</prop></defs><output $value="$label"></output></template>`);
    const checkCli = join(consumer, "node_modules/@nextwebwg/html-next-unplugin/dist/check-cli.js");
    const filesBeforeCheck = readdirSync(consumer, { recursive: true }).map(String).sort();
    for (const target of ["native", "vue", "react", "preact", "svelte", "angular"]) {
      const output = execFileSync(process.execPath, [checkCli, "--target", target, "--mode", "library", "controls.html", "--json"],
        { cwd: consumer, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ diagnostics: [] });
    }
    expect(JSON.parse(runBin(consumer, "html-next-check", ["controls.html", "--json"]))).toEqual({ diagnostics: [] });
    expect(readdirSync(consumer, { recursive: true }).map(String).sort()).toEqual(filesBeforeCheck);
    runBin(consumer, "html-next", ["build", "controls.html", "--out-dir", "bin-build"]);
    expect(existsSync(join(consumer, "bin-build/vanilla/UiLabel.js"))).toBe(true);
    runBin(consumer, "html-next-convert", ["vue", "controls.html", "--mode", "library", "--out-dir", "bin-vue"]);
    expect(existsSync(join(consumer, "bin-vue/vue/UiLabel.vue"))).toBe(true);
    runBin(consumer, "html-next-convert", ["preact", "controls.html", "--mode", "library", "--out-dir", "bin-preact"]);
    expect(existsSync(join(consumer, "bin-preact/preact/UiLabel.tsx"))).toBe(true);
    runBin(consumer, "html-next-convert", ["angular", "controls.html", "--mode", "library", "--out-dir", "bin-angular"]);
    expect(readFileSync(join(consumer, "bin-angular/angular/UiLabel.ts"), "utf8")).toContain('output[ui-label]');
    const invalid = join(consumer, "invalid.html");
    writeFileSync(invalid, '<template component="ui-invalid">\n  <ui-missing></ui-missing>\n</template>');
    const failedCheck = spawnSync(process.execPath, [checkCli, "invalid.html", "--json"], { cwd: consumer, encoding: "utf8" });
    expect(failedCheck.status).toBe(1);
    expect(failedCheck.stderr).toBe("");
    expect(JSON.parse(failedCheck.stdout)).toMatchObject({ diagnostics: [{ code: "HN001", severity: "error", line: 2, column: 3 }] });
    expect(failedCheck.stdout).not.toContain("\x1b");
    const terminalEnvironment = { ...process.env };
    delete terminalEnvironment.NO_COLOR;
    const textCheck = spawnSync(process.execPath, [checkCli, "invalid.html"], { cwd: consumer, encoding: "utf8", env: terminalEnvironment });
    expect(textCheck.status).toBe(1);
    expect(textCheck.stdout).toBe("");
    expect(textCheck.stderr).toContain("error HN001");
    expect(textCheck.stderr).toContain("invalid.html:2:3");
    expect(textCheck.stderr).toContain("\x1b]8;;vscode://file/");
    expect(textCheck.stderr.trim().split("\n")).toHaveLength(1);
    const plainCheck = spawnSync(process.execPath, [checkCli, "invalid.html", "--no-color"], { cwd: consumer, encoding: "utf8" });
    expect(plainCheck.status).toBe(1);
    expect(plainCheck.stderr).not.toContain("\x1b");
    expect(plainCheck.stderr).toContain("invalid.html:2:3");
    for (const args of [["--target", "unknown"], ["--mode"], ["--json", "missing/**/*.html"]]) {
      const failedCommand = spawnSync(process.execPath, [checkCli, ...args], { cwd: consumer, encoding: "utf8" });
      expect(failedCommand.status).toBe(2);
      expect(failedCommand.stderr.length).toBeGreaterThan(0);
    }
    writeFileSync(invalid, `<template component="ui-invalid">
  <defs>
    <prop name="age" type="integer" default="wrong">Age.</prop>
    <prop name="enabled" type="boolean" default="wrong">Enabled.</prop>
  </defs>
  <main></main>
</template>`);
    const multipleCheck = spawnSync(process.execPath, [checkCli, "invalid.html", "--json"], { cwd: consumer, encoding: "utf8" });
    expect(multipleCheck.status).toBe(1);
    expect(multipleCheck.stderr).toBe("");
    expect(JSON.parse(multipleCheck.stdout).diagnostics).toMatchObject([
      { code: "HC015", line: 3, column: 5 }, { code: "HC015", line: 4, column: 5 },
    ]);
    const multipleText = spawnSync(process.execPath, [checkCli, "invalid.html", "--no-color"], { cwd: consumer, encoding: "utf8" });
    expect(multipleText.status).toBe(1);
    expect(multipleText.stderr.trim().split("\n")).toHaveLength(2);
    rmSync(invalid);
    const assembly = join(consumer, "assemble.mjs");
    writeFileSync(assembly, `import { assembleComponentPackage } from "@nextwebwg/html-next"; await assembleComponentPackage(${JSON.stringify({
      name: "@example/source-controls", version: "1.0.0", sourceOnly: true, outDirectory: library, components: [{ source }],
    })});`);
    execFileSync(process.execPath, [assembly], { cwd: consumer, encoding: "utf8" });
    const manifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies["@example/source-controls"] = "1.0.0";
    writeFileSync(join(consumer, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(consumer, "vite.config.mjs"), `import htmlNext from "@nextwebwg/html-next-unplugin/vite"; import react from "@vitejs/plugin-react"; export default { plugins: [htmlNext({ target: "react" }), react()] };`);
    runBin(consumer, "html-next-sync");
    expect(readFileSync(join(consumer, "src/html-next.d.ts"), "utf8")).toContain('declare module "@example/source-controls"');
    writeFileSync(join(consumer, "src/main.tsx"), 'import { UiLabel } from "@example/source-controls"; export const label = <UiLabel label="Ready" />;');
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
      skipLibCheck: false, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", jsx: "react-jsx" }, include: ["src"] }));
    const tsc = join(consumer, "node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
    writeFileSync(join(consumer, "check-api.ts"), 'import { checkHtmlNext, formatCheckDiagnostic, type HtmlNextCheckDiagnostic } from "@nextwebwg/html-next-unplugin"; export const check = () => checkHtmlNext({ target: "react", mode: "library", entries: ["controls.html"] }); export const format = (diagnostic: HtmlNextCheckDiagnostic) => formatCheckDiagnostic(diagnostic);');
    // Unplugin's declarations reference optional bundlers; check API usage without installing each one.
    writeFileSync(join(consumer, "tsconfig.check.json"), JSON.stringify({ extends: "./tsconfig.json",
      compilerOptions: { skipLibCheck: true }, include: ["check-api.ts"] }));
    const checkedTypes = spawnSync(process.execPath, [tsc, "-p", "tsconfig.check.json"], { cwd: consumer, encoding: "utf8" });
    expect(checkedTypes.status, checkedTypes.stdout + checkedTypes.stderr).toBe(0);
    const libraryManifest = JSON.parse(readFileSync(join(library, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    libraryManifest.exports["."] = { "html-next": "./components/" };
    writeFileSync(join(library, "package.json"), JSON.stringify(libraryManifest));
    runBin(consumer, "html-next-sync");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
    // The packed adapter also supports zero-config native consumption of the same folder.
    // Model strict dependency installation: the app has no direct core dependency.
    const coreDependency = join(consumer, "core-dependency");
    renameSync(join(consumer, "node_modules/@nextwebwg/html-next"), coreDependency);
    for (const name of ["html-next-unplugin", "html-next-converter"]) {
      const dependencies = join(consumer, "node_modules/@nextwebwg", name, "node_modules/@nextwebwg");
      mkdirSync(dependencies, { recursive: true });
      symlinkSync(coreDependency, join(dependencies, "html-next"), process.platform === "win32" ? "junction" : "dir");
    }
    writeFileSync(join(consumer, "vite.config.mjs"), 'import htmlNext from "@nextwebwg/html-next-unplugin/vite"; export default { plugins: [htmlNext()] };');
    writeFileSync(join(consumer, "src/native.js"), 'import { createUiLabel } from "@example/source-controls"; document.body.append(createUiLabel({ label: "Ready" }));');
    writeFileSync(join(consumer, "index.html"), '<html><body><script type="module" src="/src/native.js"></script></body></html>');
    execFileSync(process.execPath, [join(consumer, "node_modules/vite/bin/vite.js"), "build"], { cwd: consumer, encoding: "utf8" });
    expect(existsSync(join(consumer, "dist/index.html"))).toBe(true);
    writeFileSync(join(consumer, "src/main.tsx"), 'import { UiLabel } from "@example/source-controls"; export const label = <UiLabel label={42} />;');
    expect(() => execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8", stdio: "pipe" })).toThrow();
    // Windows runners have measured 82-133 s for this install, build and type-check sequence.
  }, 300_000);

  for (const [target, viteVersion] of [["svelte", "8.3.4"], ["vue", "7.2.7"], ["preact", "8.3.4"]] as const) {
    it.skipIf(!includesPackage("html-next-converter", "html-next-unplugin"))(`builds a packed ${target} source consumer with Vite ${viteVersion}`, () => {
      const tarballs = ["html-next", "html-next-converter", "html-next-unplugin"].map(pack);
      const consumer = join(workspace, `framework-${target}`);
      mkdirSync(consumer);
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: `framework-${target}`, private: true, type: "module" }));
      const tooling = join(root, "packages/html-next-unplugin/node_modules");
      const version = (name: string) => JSON.parse(readFileSync(join(tooling, name, "package.json"), "utf8")).version;
      const compiler = target === "svelte" ? "@sveltejs/vite-plugin-svelte" : target === "preact" ? "@preact/preset-vite" : "@vitejs/plugin-vue";
      execFileSync("npm", ["install", "--strict-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs,
        `vite@${viteVersion}`, `${target}@${version(target)}`, `${compiler}@${version(compiler)}`], { cwd: consumer, shell: useCommandShell });
      execFileSync("npm", ["ls", "vite", "--all", "--json"], { cwd: consumer, encoding: "utf8" });
      const installedAdapter = createRequire(join(consumer, "node_modules/@nextwebwg/html-next-unplugin/package.json"));
      expect(JSON.parse(readFileSync(installedAdapter.resolve("vite/package.json"), "utf8")).version).toBe(viteVersion);
      const library = join(consumer, "node_modules/@example/controls");
      mkdirSync(join(library, "components"), { recursive: true });
      writeFileSync(join(library, "package.json"), JSON.stringify({ name: "@example/controls", version: "1.0.0", type: "module", exports: { ".": { "html-next": "./components/" } } }));
      const manifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
      manifest.dependencies["@example/controls"] = "1.0.0";
      writeFileSync(join(consumer, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(library, "components/label.html"), '<template component="ui-label"><defs><prop name="label" type="string" default="Ready">Label.</prop></defs><output>{$label}</output></template>');
      writeFileSync(join(consumer, "vite.config.mjs"), `import htmlNext from "@nextwebwg/html-next-unplugin/vite";
${target === "svelte" ? `import { svelte as framework } from "${compiler}";` : `import framework from "${compiler}";`}
export default { plugins: [htmlNext({ target: "${target}" }), framework()], build: { lib: { entry: "${target === "preact" ? "main.tsx" : "main.js"}", formats: ["iife"], name: "PackedConsumer", fileName: () => "client.js" } } };`);
      if (target === "svelte") {
        writeFileSync(join(consumer, "App.svelte"), '<script>import { UiLabel } from "@example/controls";</script><UiLabel label="Packed source" />');
        writeFileSync(join(consumer, "main.js"), 'import { mount } from "svelte"; import App from "./App.svelte"; mount(App, { target: document.body });');
      } else if (target === "preact") {
        writeFileSync(join(consumer, "main.tsx"), 'import { render } from "preact"; import { UiLabel } from "@example/controls"; render(<UiLabel label="Packed source" />, document.body);');
      } else {
        writeFileSync(join(consumer, "App.vue"), '<script setup>import { UiLabel } from "@example/controls";</script><template><UiLabel label="Packed source" /></template>');
        writeFileSync(join(consumer, "main.js"), 'import { createApp } from "vue"; import App from "./App.vue"; createApp(App).mount(document.body);');
      }
      execFileSync(process.execPath, [join(consumer, "node_modules/vite/bin/vite.js"), "build"], { cwd: consumer, encoding: "utf8" });
      expect(readFileSync(join(consumer, "dist/client.js"), "utf8")).toContain("Packed source");
    }, 180_000);
  }

  it.skipIf(!includesPackage("html-next-unplugin"))("installs packed compiler tools without undeclared framework peers", () => {
    const tarball = pack("html-next-unplugin");
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8", shell: useCommandShell }));
    // Internal SDK packages are exercised above. Isolate the shipped compiler closure from dev dependencies.
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => !name.startsWith("@nextwebwg/")));
    const consumer = join(workspace, "compiler-dependencies");
    mkdirSync(consumer);
    const manager = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "compiler-dependency-consumer", private: true, type: "module", packageManager: manager, dependencies }));
    execFileSync("corepack", ["pnpm", "install", "--ignore-scripts", "--strict-peer-dependencies", "--config.auto-install-peers=false"],
      { cwd: consumer, encoding: "utf8", shell: useCommandShell });
    execFileSync(process.execPath, ["--input-type=module", "--eval",
      'import { svelte2tsx } from "svelte2tsx"; svelte2tsx("<p>Compiler SDK</p>");'],
    { cwd: consumer, encoding: "utf8", shell: useCommandShell });
  }, 120_000);

  it("publishes every workspace package publicly on the latest tag under MIT", () => {
    const versions = new Set<string>();
    for (const packageDirectory of releaseDirectories) {
      const packageRoot = join(root, "packages", packageDirectory);
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { version: string; private?: boolean; license?: string; dependencies?: Record<string, string>; publishConfig?: { access: string; tag: string } };
      versions.add(manifest.version);
      expect(manifest.private, packageDirectory).toBeUndefined();
      expect(manifest.publishConfig, packageDirectory).toMatchObject({ access: "public", tag: "latest" });
      expect(manifest.license, packageDirectory).toBe("MIT");
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (name.startsWith("@nextwebwg/")) {
          expect(range, `${name} must allow future releases`).toMatch(/^workspace:>=/);
          expect(range, `${name} must not impose a speculative ceiling`).not.toContain("<");
        }
      }
      expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    }
    expect([...versions], "All published packages must share one version.").toHaveLength(1);
  });

});
