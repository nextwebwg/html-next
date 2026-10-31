import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);

it("typechecks recursive compositions, selected props and native attribute forwarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-react-composition-"));
  try {
    await symlink(new URL("../node_modules", import.meta.url).pathname, join(directory, "node_modules"), "dir");
    const definitions = {
      "leaf.html": `<template component="x-leaf"><defs><prop name="depth" type="integer" default="0">Remaining nested levels.</prop></defs>
        <div><x-leaf $if="$depth > 0" from:depth="$depth - 1"></x-leaf></div></template>`,
      "field.html": `<template component="x-field"><defs>
        <prop name="type" type="keyword" values="text, number" default="text">The native field mode.</prop>
        <prop name="value">The field’s current value.<type from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
        </defs><input from:type="$type" from:value="$value"></template>`,
      "page.html": `<link rel="component" href="./leaf.html"><link rel="component" href="./field.html">
        <template component="x-page"><defs><prop name="label" type="string">An optional label.</prop><prop name="hidden" type="boolean">Optional native visibility.</prop>
        <state name="selected" type="boolean" value="false"></state></defs><section>
        <x-leaf hidden></x-leaf><x-leaf from:title="$label" from:aria-label="$label" from:hidden="$hidden" from:aria-pressed="concat($selected)"></x-leaf>
        <x-field type="text" from:value="$label" name="explicit" inputmode="decimal" spellcheck="false"></x-field>
        <x-field from:value="$label"></x-field></section></template>`,
    };
    for (const [name, source] of Object.entries(definitions)) await writeFile(join(directory, name), source);
    await convertComponents({ mode: "library", target: "react", entries: Object.keys(definitions), root: directory, outDirectory: join(directory, "out") });
    await writeFile(join(directory, "consumer.tsx"), `import XField from "./out/react/XField";\nconst field = <XField name="title" inputMode="text" autoComplete="off" value="Hello" />;\nvoid field;\n`);
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, jsx: "react-jsx", noEmit: true, allowImportingTsExtensions: true,
    }, include: ["**/*.ts", "**/*.tsx"] }));
    const { stderr } = await run(process.execPath, [new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname, "-p", directory]).catch(error => { throw new Error(error.stdout || error.stderr || error.message); });
    assert.equal(stderr, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
