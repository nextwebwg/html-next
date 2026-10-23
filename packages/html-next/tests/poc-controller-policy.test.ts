import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

const read = (path: string) =>
  readFile(new URL(`../examples/poc/${path}`, import.meta.url), "utf8");

describe("live component graph example", () => {
  it("declares named-connect modules and starts from the browser entry alone", async () => {
    const [counter, chart, counterModule, chartModule, page] = await Promise.all([
      read("components/counter.html"),
      read("components/chart.html"),
      read("components/counter.js"),
      read("components/chart.js"),
      read("index.html"),
    ]);

    assert.match(counter, /<template component="x-counter" module="\.\/counter\.js"/);
    assert.match(chart, /<template component="x-chart" module="\.\/chart\.js"/);
    assert.match(counterModule, /export function connect\(\{ refs, state \}, \{ signal \}\)/);
    assert.match(chartModule, /export function connect\(\{ effect, refs, state \}\)/);
    assert.doesNotMatch(counterModule, /from ["'][^"']*poc\.js["']/);
    assert.doesNotMatch(chartModule, /from ["'][^"']*poc\.js["']/);
    assert.doesNotMatch(counterModule, /defineController/);
    assert.doesNotMatch(chartModule, /defineController/);
    // One script in the head is the whole setup: nothing calls a start function.
    assert.match(page, /<head>[\s\S]*<script type="module" src="\.\.\/\.\.\/dist\/browser\.js"><\/script>[\s\S]*<\/head>/);
    assert.doesNotMatch(page, /startBrowserComponents/);
  });

  it("uses one application-owned package prefix without a per-module manifest", async () => {
    const page = await read("index.html");

    assert.match(page, /Content-Security-Policy/);
    assert.match(page, /script-src 'self'/);
    assert.match(page, /"@poc\/components\/": "\.\/components\/"/);
    assert.match(page, /<link rel="component" href="@poc\/components\/app\.html" \/>/);
    assert.doesNotMatch(page, /html-next-controller/);
    assert.doesNotMatch(page, /poc\.js/);
  });
});
