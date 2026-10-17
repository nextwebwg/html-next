import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript-compiler";
import { afterAll, beforeAll, describe, it } from "vitest";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const separator = `<template component="ui-separator">
  <defs>
    <event name="pick" type="object({ id: string })"></event>
    <event name="change" type="integer"></event>
  </defs>
  <div></div>
</template>`;

const player = `<template component="ui-player">
  <defs><event name="cue" type="number"></event></defs>
  <video></video>
</template>`;

const usage = `import { createUiSeparator } from "./vanilla/UiSeparator.js";
import { createUiPlayer } from "./vanilla/UiPlayer.js";

const element = createUiSeparator();
const node: Node = element;
const html: HTMLElement = element;
const div: HTMLDivElement = element;
document.body.append(element);
element.addEventListener("click", (event) => { const x: number = event.clientX; void x; });
element.addEventListener("pick", (event) => { const id: string = event.detail.id; void id; });
element.addEventListener("change", (event) => { const value: number = event.detail; void value; });
element.addEventListener("custom-thing", { handleEvent() {} });
element.removeEventListener("pick", () => {});
const video: HTMLVideoElement = createUiPlayer();
createUiPlayer().addEventListener("cue", (event) => { const at: number = event.detail; void at; });
createUiPlayer().addEventListener("enterpictureinpicture", (event) => { void event.pictureInPictureWindow; });
void [node, html, div, video];
`;

let directory: string;

function typeErrors(source: string): string[] {
  const path = join(directory, "usage.ts");
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], exactOptionalPropertyTypes: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = (name) => name === path ? source : read(name);
  return ts.getPreEmitDiagnostics(ts.createProgram([path], options, host))
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("Vanilla element declarations", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-types-"));
    await writeFile(join(directory, "package.json"), '{ "type": "module" }\n');
    await mkdir(join(directory, "vanilla"));
    for (const source of [separator, player]) {
      for (const artifact of generateComponent(parseComponent(source))) {
        if (artifact.path.startsWith("vanilla/")) await writeFile(join(directory, artifact.path), artifact.content);
      }
    }
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("types native events beside declared ones, and stays assignable to its DOM types", () => {
    assert.deepEqual(typeErrors(usage), []);
  });

  it("types a declared event's detail", () => {
    const errors = typeErrors(usage.replace("const id: string = event.detail.id", "const id: number = event.detail.id"));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Type 'string' is not assignable to type 'number'/);
  });
});
