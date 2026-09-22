/**
 * Real-world proof (plan B smoke test): a representative subset of a reviewed third-party component
 * library, lowered through the current live runtime (`src/runtime.ts`, `lowerDocument`) in a real
 * browser. Confirms the post-U6 shrunk runtime still parses and lowers genuine third-party
 * declarative components to their native roots with structured projected content preserved.
 *
 * Run with:  HTMLNEXT_LIBRARY_TEST=1 pnpm exec vitest run --config vitest.browser.config.ts \
 *              packages/declarative-components/tests/component-library-smoke.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

const enabled = process.env.HTMLNEXT_LIBRARY_TEST === "1";
const runtimeUrl = new URL("../src/runtime.ts", import.meta.url);
const components = new URL("../examples/component-library/components/", import.meta.url);

// Pure declarative components — no controllers, no cross-component links.
const DECLARATIVE_TAGS = [
  "ui-button", "ui-icon-button", "ui-callout", "ui-chip", "ui-badge",
  "ui-search-shell", "ui-search-result-row", "ui-top-bar", "ui-form-field",
] as const;

describe.skipIf(!enabled)("reviewed component library (smoke)", () => {
  let directory = "";
  let bundle = "";
  let controllerBundle = "";
  let definitions = "";
  let disclosureDefinition = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-library-smoke-"));
    bundle = join(directory, "runtime.js");
    await build({
      entryPoints: [runtimeUrl.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime",
      outfile: bundle, platform: "browser", target: ["es2022"],
    });
    controllerBundle = join(directory, "controllers.js");
    await build({
      stdin: {
        contents: `import controller from ${JSON.stringify(new URL("ui-disclosure.js", components).pathname)};\n`
          + `globalThis.DisclosureController = controller;`,
        resolveDir: components.pathname,
      },
      bundle: true, format: "iife", outfile: controllerBundle, platform: "browser", target: ["es2022"],
    });
    definitions = (await Promise.all(
      DECLARATIVE_TAGS.map((tag) => readFile(new URL(`${tag}.html`, components), "utf8")),
    )).join("\n");
    disclosureDefinition = await readFile(new URL("ui-disclosure.html", components), "utf8");
  });

  afterAll(async () => {
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

  it("mounts a controller-backed component and runs its behavior", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(disclosureDefinition + `
        <ui-disclosure id="disclosure">
          <button id="disclosure-trigger">Details</button>
          <div id="disclosure-content">Body</div>
        </ui-disclosure>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const runtimeErrors = [];
        window.HtmlRuntime.observeDocument(document, {
          onError(error) { runtimeErrors.push(error.message); },
          onConnect(root, definition) {
            const controller = window.DisclosureController;
            if (definition.contract.tag !== "ui-disclosure" || controller == null) return;
            window.HtmlRuntime.setControllerModule(root, Promise.resolve({ default: controller }));
            return controller(window.HtmlRuntime.getComponentHost(root));
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const trigger = document.getElementById("disclosure-trigger");
        const content = document.getElementById("disclosure-content");
        const events = [];
        document.getElementById("disclosure").addEventListener("open", (event) => events.push(event.detail));
        const initial = { expanded: trigger.getAttribute("aria-expanded"), hidden: content.hidden };
        trigger.click();
        await Promise.resolve();
        return {
          initial,
          opened: { expanded: trigger.getAttribute("aria-expanded"), hidden: content.hidden, controls: trigger.getAttribute("aria-controls") },
          events,
          runtimeErrors,
        };
      })()`) as {
        initial: { expanded: string | null; hidden: boolean };
        opened: { expanded: string | null; hidden: boolean; controls: string | null };
        events: Array<Record<string, unknown>>;
        runtimeErrors: string[];
      };
      assert.deepEqual(result.runtimeErrors, []);
      assert.deepEqual(result.initial, { expanded: "false", hidden: true });
      assert.deepEqual(result.opened, { expanded: "true", hidden: false, controls: "disclosure-content" });
      assert.deepEqual(result.events, [{ open: true, reason: "action", trigger: "programmatic" }]);
    } finally {
      await browser.close();
    }
  });
});
