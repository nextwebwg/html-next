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
  let controllerBundle = "";
  let definitions = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-looma-components-"));
    bundle = join(directory, "runtime.js");
    await build({
      entryPoints: [runtime.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime",
      outfile: bundle, platform: "browser", target: ["es2022"],
    });
    controllerBundle = join(directory, "controllers.js");
    const controllerTags = [
      "ui-checkbox", "ui-input", "ui-textarea", "ui-select", "ui-radio", "ui-radio-group", "ui-switch",
    ];
    await build({
      stdin: {
        contents: controllerTags.map((tag, index) =>
          `import controller${index} from ${JSON.stringify(new URL(`${tag}.js`, components).pathname)};`,
        ).join("\n") + `\nglobalThis.LoomaControllers = {${controllerTags.map((tag, index) =>
          `${JSON.stringify(tag)}: controller${index}`,
        ).join(",")}};`,
        resolveDir: components.pathname,
      },
      bundle: true, format: "iife", outfile: controllerBundle, platform: "browser", target: ["es2022"],
    });
    definitions = (await Promise.all([
      "ui-button", "ui-icon-button", "ui-callout", "ui-chip", "ui-badge",
      "ui-search-shell", "ui-search-result-row", "ui-top-bar", "ui-form-field",
      ...controllerTags,
    ].map((tag) => readFile(new URL(`${tag}.html`, components), "utf8")))).join("\n");
  });

  it("preserves native form controls and controlled or default state", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-input id="input" value="locked@example.com" invalid><input id="native-input" type="email" required></ui-input>
        <ui-textarea id="textarea" default-value="draft" rows="7"><textarea id="native-textarea"></textarea></ui-textarea>
        <ui-select id="select" default-value="b" required><select id="native-select"><option value="a">A</option><option value="b">B</option></select></ui-select>
        <ui-checkbox id="checkbox" default-checked required><input id="native-checkbox" type="checkbox"></ui-checkbox>
        <ui-radio id="radio" default-checked value="solo"><input id="native-radio" type="radio"></ui-radio>
        <ui-radio-group id="group" name="choice" value="a" orientation="horizontal">
          <ui-radio id="radio-a" value="a"><input id="native-radio-a" type="radio"></ui-radio>
          <ui-radio id="radio-b" value="b"><input id="native-radio-b" type="radio"></ui-radio>
        </ui-radio-group>
        <ui-switch id="switch" default-checked>Enabled</ui-switch>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const original = ['native-input','native-textarea','native-select','native-checkbox','native-radio','native-radio-a','native-radio-b']
          .map(id => document.getElementById(id));
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve({ default: controller }));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        const inputRoot = document.getElementById('input');
        const input = document.getElementById('native-input');
        const textareaRoot = document.getElementById('textarea');
        const textarea = document.getElementById('native-textarea');
        const select = document.getElementById('native-select');
        const checkboxRoot = document.getElementById('checkbox');
        const checkbox = document.getElementById('native-checkbox');
        const group = document.getElementById('group');
        const radioB = document.getElementById('native-radio-b');
        const switchRoot = document.getElementById('switch');
        const switchInput = switchRoot.querySelector('input');
        const details = [];
        for (const root of [inputRoot, textareaRoot, checkboxRoot, group, switchRoot]) {
          for (const event of ['input','change','select']) root.addEventListener(event, e => {
            if (e.detail != null) details.push([root.id, event, e.detail]);
          });
        }
        input.value = 'edited'; input.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = 'notes'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
        select.value = 'a'; select.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        radioB.checked = true; radioB.dispatchEvent(new Event('change', { bubbles: true }));
        switchRoot.click();
        await Promise.resolve(); await Promise.resolve();
        return {
          same: original.every(node => node === document.getElementById(node.id)),
          input: { value: input.value, invalid: inputRoot.hasAttribute('data-invalid'), aria: input.getAttribute('aria-invalid'), typeMismatch: input.validity.typeMismatch },
          textarea: { value: textarea.value, rows: textarea.rows },
          select: { value: select.value, required: select.required },
          checkbox: { checked: checkbox.checked, required: checkbox.required, aria: checkboxRoot.getAttribute('aria-checked') },
          radio: { checked: document.getElementById('native-radio').checked, value: document.getElementById('native-radio').value },
          group: { value: group.value, a: document.getElementById('native-radio-a').checked, b: radioB.checked, bName: radioB.name },
          switch: { checked: switchInput.checked, aria: switchRoot.getAttribute('aria-checked') },
          details,
        };
      })()`) as {
        same: boolean;
        input: unknown;
        textarea: unknown;
        select: unknown;
        checkbox: unknown;
        radio: unknown;
        group: unknown;
        switch: unknown;
        details: Array<[string, string, { value?: string; checked?: boolean }]>;
      };
      assert.equal(result.same, true);
      assert.deepEqual(result.input, { value: "locked@example.com", invalid: true, aria: "true", typeMismatch: false });
      assert.deepEqual(result.textarea, { value: "notes", rows: 7 });
      assert.deepEqual(result.select, { value: "a", required: true });
      assert.deepEqual(result.checkbox, { checked: false, required: true, aria: "false" });
      assert.deepEqual(result.radio, { checked: true, value: "solo" });
      assert.deepEqual(result.group, { value: "a", a: false, b: true, bName: "choice" });
      assert.deepEqual(result.switch, { checked: false, aria: "false" });
      assert.ok(result.details.some(([id, event, detail]) => id === "textarea" && event === "input" && detail.value === "notes"));
      assert.ok(result.details.some(([id, event, detail]) => id === "checkbox" && event === "change" && detail.checked === false));
      assert.ok(result.details.some(([id, event, detail]) => id === "group" && event === "select" && detail.value === "b"));
    } finally {
      await browser.close();
    }
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
