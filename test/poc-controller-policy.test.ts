import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path: string) =>
  readFile(new URL(`../examples/poc/${path}`, import.meta.url), "utf8");

describe("proof-of-concept controller loading", () => {
  it("loads each definition's controller through the standard module graph", async () => {
    const [counter, chart, runtime] = await Promise.all([
      read("components/counter.html"),
      read("components/chart.html"),
      read("poc.js"),
    ]);

    assert.match(counter, /<template component="x-counter" controller="\.\/counter\.js">/);
    assert.match(chart, /<template component="x-chart" controller="\.\/chart\.js">/);
    assert.match(runtime, /template\.getAttribute\("controller"\)/);
    assert.match(runtime, /resolveDependency\(controller, definitionURL\)/);
    assert.match(runtime, /import\(controllerURL\)/);
    assert.match(runtime, /snapshotApplicationImports\(\)/);
    assert.match(runtime, /key\.endsWith\("\/"\) && specifier\.startsWith\(key\)/);
    assert.match(runtime, /script, base, meta\[http-equiv\]/);
    assert.doesNotMatch(runtime, /link\[rel="controller"\]/);
    assert.doesNotMatch(runtime, /html-next-controller/);
    assert.doesNotMatch(runtime, /controllerHints/);
  });

  it("uses one application-owned package prefix without a per-controller manifest", async () => {
    const page = await read("index.html");

    assert.match(page, /Content-Security-Policy/);
    assert.match(page, /script-src 'self'/);
    assert.match(page, /"@poc\/components\/": "\.\/components\/"/);
    assert.match(page, /<link rel="component" href="@poc\/components\/app\.html" \/>/);
    assert.doesNotMatch(page, /html-next-controller/);
    assert.doesNotMatch(page, /\scontrollers(?:\s|>)/);

    const source = await read("poc.js");
    const digest = `sha384-${createHash("sha384").update(source).digest("base64")}`;
    assert.ok(page.includes(`integrity="${digest}"`), "poc.js script integrity is stale");
  });
});
