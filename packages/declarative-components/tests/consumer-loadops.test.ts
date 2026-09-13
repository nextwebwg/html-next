import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium } from "playwright";

import { assembleFixtureLooma } from "./helpers/looma-package.js";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const libraryPath = new URL("../src/index.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

describe.skipIf(!enabled)("LoadOps-shaped package consumer", () => {
  let directory = "";
  let bundle = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-loadops-"));
    await assembleFixtureLooma(directory);
    const entry = join(directory, "loadops-entry.js");
    const registration = join(directory, "dist/index.js");
    await writeFile(entry, `import ${JSON.stringify(registration)};
import ${JSON.stringify(registration)};
export const loaded = true;`);
    bundle = join(directory, "registration.js");
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      nodePaths: [nodeModulesPath],
      alias: { "@nextwebwg/declarative-components/runtime": runtimePath, "@nextwebwg/declarative-components": libraryPath },
    });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("upgrades directly authored tags and retains native email validation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<form id="form">
          <ui-form-field id="field" label="Email" required><ui-input id="email" invalid><input id="native-email" type="email" required value="bad"></ui-input></ui-form-field>
          <ui-input id="date"><input id="native-date" type="date" min="2024-01-01" value="2023-12-31"></ui-input>
          <ui-input id="number"><input id="native-number" type="number" min="10" step="2" value="11"></ui-input>
          <ui-select id="select" required><select id="native-select" required><option value="">Choose</option></select></ui-select>
          <button id="anchor" type="button">Anchor</button><ui-popover id="popover" for="anchor" default-open>Details</ui-popover>
          <ui-stack id="stack" gap="s"><span>A</span><span>B</span></ui-stack>
          <ui-button id="save">Save</ui-button>
        </form>`,
      );
      await page.addScriptTag({ path: bundle });
      await page.waitForSelector('#email[data-component-root~="ui-input"]');
      const result = await page.evaluate(() => {
        const input = document.querySelector("#native-email") as HTMLInputElement;
        const button = document.querySelector("#save") as HTMLButtonElement;
        return {
          inputRoot: document.querySelector("#email")?.localName,
          input: input.localName,
          button: button.localName,
          label: button.textContent,
          value: input.value,
          required: input.required,
          invalid: !input.checkValidity() && input.validity.typeMismatch,
          dateUnderflow: (document.querySelector("#native-date") as HTMLInputElement).validity.rangeUnderflow,
          numberStep: (document.querySelector("#native-number") as HTMLInputElement).validity.stepMismatch,
          selectMissing: (document.querySelector("#native-select") as HTMLSelectElement).validity.valueMissing,
          formValid: (document.querySelector("#form") as HTMLFormElement).checkValidity(),
          field: [document.querySelector("#field")?.localName, document.querySelector("#field legend")?.textContent],
          popover: [document.querySelector("#popover")?.localName, (document.querySelector("#popover") as HTMLElement).hidden],
          stack: document.querySelector("#stack")?.localName,
        };
      });
      assert.deepEqual(result, {
        inputRoot: "div", input: "input", button: "button", label: "Save", value: "bad", required: true, invalid: true,
        dateUnderflow: true, numberStep: true, selectMissing: true, formValid: false,
        field: ["fieldset", "Email"], popover: ["div", false], stack: "div",
      });
    } finally {
      await browser.close();
    }
  });
});
