import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { GENERATOR_VERSION } from "../src/generate.js";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly files: readonly string[];
  readonly bin: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, { readonly types: string; readonly import: string }>>;
  readonly publishConfig: {
    readonly access: string;
    readonly tag: string;
    readonly registry: string;
  };
}

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const packageLicense = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
const repositoryLicense = await readFile(new URL("../../../LICENSE", import.meta.url), "utf8");
const expectedExports = [
  ".",
  "./runtime",
  "./generated-runtime",
  "./forms",
  "./validation",
  "./browser-loader",
  "./browser",
  "./node-loader",
];

assert.equal(manifest.name, "@nextwebwg/html-next");
assert.equal(GENERATOR_VERSION, manifest.version, "Generator and package versions must match.");
assert.equal(manifest.license, "MIT");
assert.equal(packageLicense, repositoryLicense, "The packed MIT notice must match the repository.");
assert.deepEqual(manifest.files, ["dist"]);
assert.deepEqual(manifest.bin, { "html-next": "./dist/cli.js" });
assert.deepEqual(Object.keys(manifest.exports), expectedExports);
for (const [path, conditions] of Object.entries(manifest.exports)) {
  assert.match(conditions.import, /^\.\/dist\/.+\.js$/, `${path} must publish a JavaScript entry.`);
  assert.match(conditions.types, /^\.\/dist\/.+\.d\.ts$/, `${path} must publish a declaration entry.`);
}
assert.deepEqual(manifest.publishConfig, {
  access: "public",
  tag: "next",
  registry: "https://registry.npmjs.org/",
});

process.stdout.write(`Release mechanics verified for ${manifest.name}@${manifest.version}.\n`);
