import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const repositoryLicense = readFileSync(join(root, "LICENSE"), "utf8");
const workspace = mkdtempSync(join(tmpdir(), "html-next-package-consumer-"));
const useCommandShell = process.platform === "win32";
const componentsPackage = "@nextwebwg/html-next";
const releaseDirectories = ["html-next", "html-next-converter", "html-next-unplugin", "htmlkit"] as const;
const publicExports = [
  ".",
  "./runtime",
  "./live",
  "./generated-runtime",
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
  "./forms",
  "./validation",
  "./browser",
] as const;

// Removing the installed consumers on Windows can outlast the default hook budget.
afterAll(() => rmSync(workspace, { recursive: true, force: true }), 60_000);

function pack(packageDirectory: string): string {
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
  return isAbsolute(packed!) ? packed! : join(workspace, packed!);
}

function specifier(path: typeof publicExports[number]): string {
  return path === "." ? componentsPackage : `${componentsPackage}/${path.slice(2)}`;
}

describe("workspace package contracts", () => {
  it("installs HTML Next with every public export", () => {
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
    writeFileSync(
      nodeEntry,
      `${publicExports
        .filter((path) => path !== "./browser")
        .map((path) => `import ${JSON.stringify(specifier(path))};`)
        .join("\n")}\nconst { renderComponents } = await import("@nextwebwg/html-next/server");\nconst { parseComponent } = await import("@nextwebwg/html-next");\nconst rendered = await renderComponents("<x-packed>Package SSR</x-packed>", { definitions: [parseComponent('<template component="x-packed"><p><slot></slot></p></template>')] });\nif (!rendered.html.includes('data-component="x-packed"') || !rendered.html.includes("Package SSR")) throw new Error("Packaged server rendering failed");\nprocess.stdout.write("ok");\n`,
    );
    expect(
      execFileSync(process.execPath, [nodeEntry], { cwd: consumer, encoding: "utf8" }),
    ).toBe("ok");

    const typeEntry = join(consumer, "public-exports.ts");
    writeFileSync(
      typeEntry,
      `${publicExports.map((path, index) =>
        `import * as publicExport${index} from ${JSON.stringify(specifier(path))};`
      ).join("\n")}\nexport const resolved = [${publicExports.map((_, index) => `publicExport${index}`).join(", ")}];\n`,
    );
    execFileSync(
      "corepack",
      [
        "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
        "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", typeEntry,
      ],
      { cwd: root, shell: useCommandShell },
    );
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
  }, 120_000);

  it("installs the source adapter and prepares React types through the consumer Vite config", () => {
    const tarballs = releaseDirectories.map(pack);
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
    for (const target of ["native", "vue", "react", "svelte"]) {
      const output = execFileSync(process.execPath, [checkCli, "--target", target, "--mode", "library", "controls.html", "--json"],
        { cwd: consumer, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ diagnostics: [] });
    }
    expect(readdirSync(consumer, { recursive: true }).map(String).sort()).toEqual(filesBeforeCheck);
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
    const cli = join(consumer, "node_modules/@nextwebwg/html-next-unplugin/dist/cli.js");
    execFileSync(process.execPath, [cli], { cwd: consumer, encoding: "utf8" });
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
    execFileSync(process.execPath, [cli], { cwd: consumer, encoding: "utf8" });
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

  it("publishes every workspace package publicly on the latest tag under MIT", () => {
    const versions = new Set<string>();
    for (const packageDirectory of releaseDirectories) {
      const packageRoot = join(root, "packages", packageDirectory);
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { version: string; private?: boolean; license?: string; publishConfig?: { access: string; tag: string } };
      versions.add(manifest.version);
      expect(manifest.private, packageDirectory).toBeUndefined();
      expect(manifest.publishConfig, packageDirectory).toMatchObject({ access: "public", tag: "latest" });
      expect(manifest.license, packageDirectory).toBe("MIT");
      expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toBe(repositoryLicense);
    }
    expect([...versions], "All published packages must share one version.").toHaveLength(1);
  });

  it("builds a static application through the installed HTMLKit CLI", () => {
    const consumer = join(workspace, "htmlkit-consumer");
    mkdirSync(join(consumer, "app/pages"), { recursive: true });
    mkdirSync(join(consumer, "app/layouts"), { recursive: true });
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "htmlkit-consumer", private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", pack("html-next"), pack("htmlkit")], { cwd: consumer, shell: useCommandShell });
    writeFileSync(join(consumer, "htmlkit.config.ts"), 'import { defineConfig } from "@nextwebwg/htmlkit"; export default defineConfig({ base: "/packed/", routeOrdering: true });');
    writeFileSync(join(consumer, "app/layouts/default.html"), '<link rel="component" href="@nextwebwg/htmlkit/components/navigation.html"><template component="packed-shell"><title>Layout default</title><defs><prop name="navigation" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop></defs><main><htmlkit-navigation from:items="navigation"></htmlkit-navigation><slot name="page"></slot></main></template>');
    writeFileSync(join(consumer, "app/layouts/default.server.ts"), 'export const load = async ({ navigation }) => ({ props: { navigation: await navigation() } });');
    writeFileSync(join(consumer, "app/pages/01-index.html"), '<meta name="htmlkit:page" content="packed-page"><template component="packed-label"><title>Helper default</title><strong>Packaged helper</strong></template><template component="packed-page"><title $value="label"></title><defs><prop name="label" type="string" required>Label</prop></defs><section><h1 $value="label"></h1><packed-label></packed-label></section></template>');
    writeFileSync(join(consumer, "app/pages/01-index.server.ts"), 'export const load = () => ({ props: { label: "Installed platform" } });');
    const installed = join(consumer, "node_modules/@nextwebwg/htmlkit");
    const output = execFileSync(process.execPath, [join(installed, "dist/cli.js"), "build"], { cwd: consumer, encoding: "utf8" });
    expect(output).toContain("Generated 1 pages");
    const html = readFileSync(join(consumer, "dist/index.html"), "utf8");
    expect(html).toContain("Installed platform");
    expect(html).toContain("<title>Installed platform</title>");
    expect(html).toContain('data-component="packed-shell"');
    expect(html).toContain("Packaged helper");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/packed/"');
    expect(html).toContain('src="/packed/_htmlkit/');
    expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).dependencies[componentsPackage]).not.toContain("workspace:");
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toBe(repositoryLicense);
    const entry = join(consumer, "platform-types.ts");
    writeFileSync(entry, 'import { defineConfig, type Application, type LoadContext, type LoaderResult, type RouteInput } from "@nextwebwg/htmlkit"; export const config = defineConfig({ routes: [] satisfies RouteInput[] }); export type PublicTypes = [Application, LoadContext, LoaderResult];');
    execFileSync("corepack", ["pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", entry], { cwd: root, shell: useCommandShell });
  }, 120_000);
});
