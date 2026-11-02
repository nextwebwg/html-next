import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { checkConversion, convertComponents } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

import { angularControls, angularController, angularRequestController, angularTypedController, angularSetup } from "./fixtures/angular-controls.js";

for (const mode of ["application", "library"] as const) it(`converts an Angular ${mode} with native hosts and collapsed root identities`, async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-")); roots.push(root);
  await mkdir(join(root, "out"));
  await writeFile(join(root, "controls.html"), angularControls.replace("<style>", '<style>[component~="ui-button"], [data-component~="ui-button"] { outline-width: 2px; }'));
  await writeFile(join(root, "connected.js"), angularController);
  await writeFile(join(root, "ask.js"), angularRequestController);
  await writeFile(join(root, "typed.ts"), angularTypedController);
  await writeFile(join(root, "setup.ts"), angularSetup);
  const manifest = await convertComponents({ target: "angular", mode, root, entries: ["controls.html"], outDirectory: join(root, "out") });
  assert.equal(manifest.targetVersion, "21.2.24");
  assert.deepEqual(manifest.package.peerDependencies, { "@angular/core": ">=21.2.24", "@angular/common": ">=21.2.24" });
  const action = manifest.components.find(item => item.tag === "ui-action")!;
  const code = await readFile(join(root, "out", action.artifact), "utf8");
  assert.match(code, /button\[ui-action\]/);
  assert.match(code, /"ui-action": ""/);
  assert.match(code, /"ui-button": ""/);
  assert.doesNotMatch(code, /(?:data-)?component[~\]=]|<ui-button|<button/);
  assert.match(code, /\[ui-action\]/);
  assert.match(code, /\[ui-button\]/);
  assert.match(code, /Action/);
});


it("compiles native-root Angular components and checks consumer input bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-compile-")); roots.push(root);
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "controls.html"), angularControls);
  await writeFile(join(root, "connected.js"), angularController);
  await writeFile(join(root, "ask.js"), angularRequestController);
  await writeFile(join(root, "typed.ts"), angularTypedController);
  await writeFile(join(root, "setup.ts"), angularSetup);
  await convertComponents({ target: "angular", mode: "library", root, entries: ["controls.html"], outDirectory: join(root, "out") });
  const app = `import { Component } from "@angular/core"; import UiAction from "./out/angular/UiAction";
    @Component({selector: "app-root", standalone: true, imports: [UiAction], template: \`<button ui-action [text]="'Send'"></button>\`}) export class App {}`;
  await writeFile(join(root, "app.ts"), app);
  const config = join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
    skipLibCheck: true, experimentalDecorators: true, declaration: true, rewriteRelativeImportExtensions: true,
    rootDir: root, outDir: join(root, "build"), types: [] }, angularCompilerOptions: { strictTemplates: true }, files: ["app.ts"] }));
  const require = createRequire(import.meta.url);
  const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
  const compile = () => promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: root });
  try { await compile(); } catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
  assert.match(await readFile(join(root, "build/out/angular/UiAction.d.ts"), "utf8"), /ɵɵComponentDeclaration/);
  await writeFile(join(root, "app.ts"), app.replace("[text]=\"'Send'\"", "[text]=\"42\""));
  await assert.rejects(compile, error => /not assignable to type 'string'/.test((error as { stderr?: string }).stderr ?? ""));
}, 60_000);


for (const [description, source, message] of [
  ["multiple control bindings", '<template component="ui-test"><defs><state name="value" type="string" value="token"></state><state name="checked" type="boolean" value="false"></state></defs><input type="checkbox" bind:value="value" bind:checked="checked"></template>', /multiple two-way/],
  ["projected select defaults", '<template component="ui-test"><defs><state name="choice" type="string" value="b"></state></defs><select bind:value="choice"><slot><option value="a" selected>A</option></slot></select></template>', /projected options/],
  ["fragment HTML", '<template component="ui-test"><div><template $html="true"></template></div></template>', /template \$html/],
] as const) it(`reports unsupported Angular ${description} during a no-output check`, async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-check-")); roots.push(root);
  await writeFile(join(root, "test.html"), source);
  await assert.rejects(checkConversion({ target: "angular", mode: "library", root, entries: ["test.html"] }), message);
});


it("emits the context dependency for public state without an in-graph reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-public-")); roots.push(root);
  await writeFile(join(root, "counter.html"), '<template component="ui-counter"><defs><state name="count" type="integer" value="0"></state></defs><button>{$count}</button></template>');
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ target: "angular", mode: "library", root, entries: ["counter.html"], outDirectory, publicState: true });
  assert.ok(manifest.output.artifacts.some(artifact => artifact.path === "angular/context.ts"));
  assert.match(await readFile(join(outDirectory, "angular/context.ts"), "utf8"), /contextToken/);
});


it("compiles recursive object inputs and native root choices through an Angular library consumer", async () => {
  const { angularStructural } = await import("./fixtures/angular-structural.js");
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-structural-")); roots.push(root);
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "components.html"), angularStructural);
  const manifest = await convertComponents({ target: "angular", mode: "library", root, entries: ["components.html"], outDirectory: join(root, "out") });
  assert.equal(manifest.components.length, 5);
  const branch = await readFile(join(root, "out/angular/UiBranch.ts"), "utf8");
  assert.match(branch, /data-ui-branch-prop-href/);
  assert.doesNotMatch(branch, /"\[attr\.href\]":/);

  const app = `import { Component } from "@angular/core"; import { UiBranch, UiTreeParent } from "./out/angular/index";
    @Component({ selector: "app-root", standalone: true, imports: [UiBranch, UiTreeParent], template: \`<ng-template #badge><i>New</i></ng-template><ng-template ui-branch id="action" [slots]="{ badge: badge }" [href]="null" (saved)="receive($event)"><b>Save</b></ng-template><div ui-tree-parent [current]="node"></div>\` }) export class App {
      node = { kind: "branch", label: "Root", children: [{ kind: "leaf", label: "Child" }] };
      receive(event: CustomEvent<number>): void { void event.detail; }
    }`;
  await writeFile(join(root, "app.ts"), app);
  const config = join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
    skipLibCheck: true, experimentalDecorators: true, declaration: true, rewriteRelativeImportExtensions: true,
    rootDir: root, outDir: join(root, "build"), types: [] }, angularCompilerOptions: { strictTemplates: true }, files: ["app.ts"] }));
  const require = createRequire(import.meta.url);
  const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
  const compile = () => promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: root });
  try { await compile(); } catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
  await writeFile(join(root, "app.ts"), app.replace("[href]=\"null\"", "[href]=\"42\""));
  await assert.rejects(compile, error => /not assignable to type 'string/.test((error as { stderr?: string }).stderr ?? ""));
}, 60_000);
