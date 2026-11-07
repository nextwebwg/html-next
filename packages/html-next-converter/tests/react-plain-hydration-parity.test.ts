import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright";
import { plainSlotExpected } from "../../html-next/tests/fixtures/plain-slot-ownership.js";
import { plainSlotRendering } from "./fixtures/plain-slot-rendering.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${target} hydrates shared plain output without replacing native controls`, async () => {
  const { directory, html, entry } = await plainSlotRendering(target);
  const browser = await chromium.launch({ headless: true });
  try {
    const code = await build({ stdin: { contents: `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { hydrateRoot } from ${JSON.stringify(target === "react" ? "react-dom/client" : "preact/compat/client")};
import { XSsrPlain } from ${JSON.stringify(entry)};
function App() { React.useEffect(() => { window.plainHydrated = true; }, []); return <XSsrPlain />; }
window.plainRecovery = []; hydrateRoot(document.querySelector("#mount"), <React.StrictMode><App /></React.StrictMode>, { onRecoverableError(error) { window.plainRecovery.push(error.message); } });`, loader: "tsx", resolveDir: directory },
      bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}),
      loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setContent(`<div id="mount">${html}</div>`);
    const input = await page.locator("[data-repeated-plain] input").elementHandle();
    await page.locator("[data-repeated-plain] input").fill("Before hydration");
    await page.addScriptTag({ content: code.outputFiles[0]!.text });
    await page.waitForFunction(() => (window as any).plainHydrated === true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.ok(await input!.evaluate(node => node === document.querySelector("[data-repeated-plain] input")), JSON.stringify(await page.evaluate(() => (window as any).plainRecovery)));
    assert.equal(await page.locator("[data-repeated-plain] input").inputValue(), "Before hydration");
    assert.deepEqual(await page.locator("[data-plain-case] > section").evaluateAll(sections => sections.map(section => Array.from(section.children, child => [child.localName, child.textContent]))), plainSlotExpected);
    assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
