import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium } from "playwright";

import { assembleComponentPackage } from "../src/package.js";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const fixture = new URL("./fixtures/package/", import.meta.url).pathname;
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

describe("LoadOps-shaped package consumer", { skip: !enabled }, () => {
  let directory = "";
  let bundle = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-loadops-"));
    await assembleComponentPackage({
      name: "@threadlabs/looma",
      version: "1.0.0",
      outDirectory: directory,
      components: [
        { source: `${fixture}/ui-button.html` },
        { source: `${fixture}/ui-input.html` },
      ],
      passThrough: [{ source: `${fixture}/tokens.css`, target: "tokens.css" }],
    });
    bundle = join(directory, "registration.js");
    await build({
      entryPoints: [join(directory, "dist/index.js")],
      outfile: bundle,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      nodePaths: [nodeModulesPath],
      alias: { "@nextwebwg/html/runtime": runtimePath },
    });
  });

  after(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("upgrades directly authored tags and retains native email validation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<form><ui-input id="email" required value="bad"></ui-input><ui-button id="save">Save</ui-button></form>',
      );
      await page.addScriptTag({ path: bundle });
      await page.waitForSelector('input[data-component-root~="ui-input"]');
      const result = await page.evaluate(() => {
        const input = document.querySelector("#email") as HTMLInputElement;
        const button = document.querySelector("#save") as HTMLButtonElement;
        return {
          input: input.localName,
          button: button.localName,
          label: button.textContent,
          value: input.value,
          required: input.required,
          invalid: !input.checkValidity() && input.validity.typeMismatch,
        };
      });
      assert.deepEqual(result, {
        input: "input", button: "button", label: "Save", value: "bad", required: true, invalid: true,
      });
    } finally {
      await browser.close();
    }
  });
});
