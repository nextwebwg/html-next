import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { convertComponents } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

for (const target of ["vue", "react", "preact", "svelte", "angular"] as const) it(`normalizes component identities in ${target} styles through the shared converter`, async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-style-identity-")); roots.push(root);
  await writeFile(join(root, "shared.css"), '[component~="ui-base"], [data-component~="ui-base"] { border-width: 2px; }');
  await writeFile(join(root, "components.html"), `<template component="ui-base"><button><span title="[component]">Base</span><slot></slot></button><style>
    @import "shared.css";
    :host { color: red; }
    @scope ([data-component~="ui-base"]) { [title="[component]"] { --label: "[component]"; } }
    </style></template>
    <template component="ui-action"><ui-base>Action</ui-base><style>:host { font-style: italic; }</style></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ target, mode: "library", root, entries: ["components.html"], outDirectory });
  const files = await Promise.all(manifest.output.artifacts.filter(file => file.kind === "component" || file.kind === "style")
    .map(file => readFile(join(outDirectory, file.path), "utf8")));
  const output = files.join("\n");
  assert.doesNotMatch(output, /\[data-component[~\]]/);
  assert.match(output, /\[component\]/, "quoted authored values survive conversion");
  assert.match(output, /border-width: 2px/);
  assert.match(output, /font-style: italic/);
  if (target === "angular") assert.match(output, /\[ui-base\]/);
  else if (target === "react" || target === "preact") assert.match(output, /\[component~=/);
  else assert.match(output, /\.ui-base/);
});
