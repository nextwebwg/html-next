import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium } from "playwright";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const components = new URL("../examples/looma/components/", import.meta.url);
const runtime = new URL("../src/runtime.ts", import.meta.url);

describe("reviewed Looma HTML Next components", { skip: !enabled }, () => {
  let directory = "";
  let bundle = "";
  let definitions = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-looma-components-"));
    bundle = join(directory, "runtime.js");
    await build({
      entryPoints: [runtime.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime",
      outfile: bundle, platform: "browser", target: ["es2022"],
    });
    definitions = (await Promise.all([
      "ui-button", "ui-icon-button", "ui-callout", "ui-chip", "ui-badge",
      "ui-search-shell", "ui-search-result-row", "ui-top-bar", "ui-form-field",
    ].map((tag) => readFile(new URL(`${tag}.html`, components), "utf8")))).join("\n");
  });

  after(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("uses native controls and preserves structured projected content", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-button id="button" disabled variant="solid"><span id="button-label">Save</span></ui-button>
        <ui-icon-button id="icon" label="Settings"><svg id="icon-node"></svg></ui-icon-button>
        <ui-callout id="callout" tone="warning"><p id="message">Careful</p></ui-callout>
        <ui-chip id="chip" appearance="pill">Tag</ui-chip>
        <ui-badge id="badge" tone="positive">Ready</ui-badge>
        <ui-search-shell id="search"><input id="search-input" slot="search"><p id="search-body" slot="body">Result</p></ui-search-shell>
        <ui-search-result-row id="row" selected><strong id="row-title" slot="title">Title</strong></ui-search-result-row>
        <ui-top-bar id="top"><strong id="top-title">Workspace</strong><button id="top-action" slot="actions">Add</button></ui-top-bar>
        <ui-form-field id="field" label="Email" required><input id="field-input" type="email"></ui-form-field>
      `);
      await page.addScriptTag({ path: bundle });
      const result = await page.evaluate(() => {
        const original = ["button-label", "icon-node", "message", "search-input", "search-body", "row-title", "top-title", "top-action", "field-input"]
          .map((id) => document.getElementById(id));
        (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
        return {
          roots: ["button", "icon", "callout", "chip", "badge", "search", "row", "top", "field"]
            .map((id) => document.getElementById(id)?.localName),
          same: original.every((node) => node === document.getElementById(node!.id)),
          disabled: (document.getElementById("button") as HTMLButtonElement).disabled,
          variant: document.getElementById("button")?.getAttribute("data-variant"),
          iconLabel: document.getElementById("icon")?.getAttribute("aria-label"),
          callout: [document.getElementById("callout")?.getAttribute("role"), document.getElementById("callout")?.getAttribute("data-tone")],
          selected: document.getElementById("row")?.getAttribute("aria-selected"),
          fieldLegend: document.querySelector("#field legend")?.textContent,
        };
      });
      assert.deepEqual(result, {
        roots: ["button", "button", "aside", "span", "span", "div", "button", "header", "fieldset"],
        same: true,
        disabled: true,
        variant: "solid",
        iconLabel: "Settings",
        callout: ["note", "warning"],
        selected: "",
        fieldLegend: "Email",
      });
    } finally {
      await browser.close();
    }
  });
});
