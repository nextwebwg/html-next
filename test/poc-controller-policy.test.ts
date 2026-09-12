import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path: string) =>
  readFile(new URL(`../examples/poc/${path}`, import.meta.url), "utf8");

describe("proof-of-concept controller policy", () => {
  it("keeps controller requests from authorizing execution", async () => {
    const [counter, chart, runtime] = await Promise.all([
      read("components/counter.html"),
      read("components/chart.html"),
      read("poc.js"),
    ]);

    assert.match(counter, /<link rel="controller" href="\.\/counter\.js"\s*\/>/);
    assert.match(chart, /<link rel="controller" href="\.\/chart\.js"\s*\/>/);
    assert.match(runtime, /approved = import\.meta\.resolve\(specifier\)/);
    assert.match(runtime, /if \(requested !== approved\)/);
    assert.match(runtime, /import\(specifier\)/);
    assert.doesNotMatch(runtime, /import\(requested\)/);
    assert.match(runtime, /const specifier = `html-next-controller\/\$\{tag\}`/);
    assert.doesNotMatch(runtime, /controllerHints/);
  });

  it("requires the application to map and integrity-pin approved controllers", async () => {
    const page = await read("index.html");

    assert.match(page, /"html-next-controller\/x-counter": "\.\/components\/counter\.js"/);
    assert.match(page, /"html-next-controller\/x-chart": "\.\/components\/chart\.js"/);
    assert.match(page, /"integrity": \{/);
    assert.match(page, /"\.\/components\/counter\.js": "sha384-[A-Za-z0-9+/]+"/);
    assert.match(page, /"\.\/components\/chart\.js": "sha384-[A-Za-z0-9+/]+"/);

    for (const path of ["components/counter.js", "components/chart.js", "poc.js"]) {
      const source = await read(path);
      const digest = `sha384-${createHash("sha384").update(source).digest("base64")}`;
      assert.ok(page.includes(`"./${path}": "${digest}"`), `${path} import-map integrity is stale`);
    }
  });
});
