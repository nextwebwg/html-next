import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type ElementHandle } from "playwright";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { plainSlotExpected } from "../../html-next/tests/fixtures/plain-slot-ownership.js";
import { plainSlotRendering } from "./fixtures/plain-slot-rendering.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} hydrates shared plain output without replacing native controls`, async () => {
  const { directory, html, entry } = await plainSlotRendering(target);
  const browser = await launchParityBrowser(browserType);
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

const nativeApplication = (target: "react" | "preact", entry: string): string => `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { XMovingList, XMovingColumn } from ${JSON.stringify(entry)};
const Context = React.createContext("Default");
function Counter() {
  const context = React.useContext(Context), id = React.useId();
  const [count, setCount] = React.useState(0), [shown, setShown] = React.useState(true);
  React.useEffect(() => { window.plainMounts = (window.plainMounts ?? 0) + 1; return () => { window.plainDisposals = (window.plainDisposals ?? 0) + 1; }; }, []);
  return <>{shown && <i data-native-content>Native</i>}<input defaultValue="Initial" /><button data-native-counter id={id} onClick={() => setCount(value => value + 1)}>{context}:{count}</button><button data-native-source onClick={() => setShown(value => !value)}>Source</button></>;
}
function Control() {
  React.useEffect(() => { window.controlMounts = (window.controlMounts ?? 0) + 1; return () => { window.controlDisposals = (window.controlDisposals ?? 0) + 1; }; }, []);
  return null;
}
function App() {
  const [context, setContext] = React.useState("Context"), [pure, setPure] = React.useState(true), [visible, setVisible] = React.useState(true);
  React.useEffect(() => { window.plainHydrated = true; }, []);
  return <Context.Provider value={context}><main><button data-native-context onClick={() => setContext(value => value + "!")}>Context</button>
    ${target === "react" ? '<button data-native-owner onClick={() => setVisible(value => !value)}>Owner</button><React.Activity mode={visible ? "visible" : "hidden"}>' : ""}
    <div data-native-state><XMovingList><XMovingColumn slots={{ cell: <React.Suspense fallback="Wait"><Counter /></React.Suspense> }} /></XMovingList></div>${target === "react" ? '<Control /></React.Activity>' : ""}
    <div data-native-empty><button data-native-pure onClick={() => setPure(value => !value)}>Pure</button><XMovingList><XMovingColumn slots={{ cell: pure && "Plain" }} /></XMovingList></div>
    <footer>Tail</footer></main></Context.Provider>;
}`;

const conditionalApplication = (target: "react" | "preact", entry: string): string => `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { XSingleDirect, XSingleAncestor, XSingleMatch, XSingleClosed, XSingleLazyPage } from ${JSON.stringify(entry)};
const Context = React.createContext("Default");
function Counter({ name }) {
  const context = React.useContext(Context), id = React.useId(), [count, setCount] = React.useState(0);
  React.useEffect(() => { window.singleMounts ??= {}; window.singleDisposals ??= {}; window.singleMounts[name] = (window.singleMounts[name] ?? 0) + 1; return () => { window.singleDisposals[name] = (window.singleDisposals[name] ?? 0) + 1; }; }, []);
  return <><input defaultValue="Initial" /><button data-single-counter id={id} onClick={() => setCount(value => value + 1)}>{context}:{count}</button></>;
}
function App() {
  const [context, setContext] = React.useState("Context");
  React.useEffect(() => { window.plainHydrated = true; }, []);
  return <Context.Provider value={context}><main><button data-single-context onClick={() => setContext(value => value + "!")}>Context</button>
    <XSingleDirect><Counter name="direct" /></XSingleDirect><XSingleAncestor><Counter name="ancestor" /></XSingleAncestor>
    <XSingleMatch><Counter name="match" /></XSingleMatch><XSingleClosed><Counter name="closed" /></XSingleClosed><XSingleLazyPage />
  </main></Context.Provider>;
}`;

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} retains native content through single conditional outlets`, async () => {
  const application = (entry: string): string => conditionalApplication(target, entry);
  const { directory, html, entry } = await plainSlotRendering(target, application);
  const browser = await launchParityBrowser(browserType);
  try {
    for (const hydrated of [false, true]) {
      const code = await build({ stdin: { contents: application(entry) + `
import { createRoot, hydrateRoot } from ${JSON.stringify(target === "react" ? "react-dom/client" : "preact/compat/client")};
window.plainRecovery = []; const app = <React.StrictMode><App /></React.StrictMode>;
const root = ${hydrated ? 'hydrateRoot(document.querySelector("#mount"), app, { onRecoverableError(error) { window.plainRecovery.push(error.message); } })' : 'createRoot(document.querySelector("#mount"))'};
${hydrated ? "" : "root.render(app);"} window.finishPlain = () => root.unmount();`, loader: "tsx", resolveDir: directory },
        bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}),
        loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const page = await browser.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.setContent(`<div id="mount">${hydrated ? html : ""}</div>`);
      const originals = new Map<string, ElementHandle<Node>>();
      for (const name of hydrated ? ["direct", "ancestor", "match"] : []) {
        const input = page.locator(`[data-single-slot="${name}"] input`);
        originals.set(name, (await input.elementHandle())!); await input.fill("Edited");
      }
      await page.addScriptTag({ content: code.outputFiles[0]!.text });
      await page.waitForFunction(() => (window as any).plainHydrated === true && (window as any).singleMounts?.match > 0);
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle();
      for (const name of ["direct", "ancestor", "match", "closed", "lazy"]) {
        const card = page.locator(`[data-single-slot="${name}"]`), input = card.locator("input"), toggle = card.locator("[data-single-toggle]");
        if (name === "closed") { assert.equal(await input.count(), 0); await toggle.click(); await settle(); }
        const original = originals.get(name) ?? (await input.elementHandle())!;
        assert.ok(await original.evaluate((node: Node, name: string) => node === document.querySelector(`[data-single-slot="${name}"] input`), name), `${name} hydration identity`);
        await input.fill("Edited");
        const counter = card.locator("[data-single-counter]");
        const id = name === "lazy" ? null : await counter.getAttribute("id");
        if (name !== "lazy") await counter.click();
        await settle();
        const mounts = await page.evaluate(name => (window as any).singleMounts?.[name], name);
        for (let cycle = 0; cycle < 2; cycle++) {
          await toggle.click(); await settle();
          assert.equal(await input.count(), 0);
          assert.equal(await original.evaluate((node: Node) => node.isConnected), false);
          await page.locator("[data-single-context]").click(); await settle();
          await toggle.click(); await settle();
          assert.equal(await original.evaluate((node: Node, name: string) => node === document.querySelector(`[data-single-slot="${name}"] input`), name), name !== "lazy", `${name} source lifetime`);
          assert.equal(await input.inputValue(), name === "lazy" ? "Initial" : "Edited");
          if (name !== "lazy") {
            assert.equal(await counter.getAttribute("id"), id);
            assert.ok((await counter.textContent())!.endsWith(":1"));
            assert.equal(await page.evaluate(name => (window as any).singleMounts[name], name), mounts);
          }
          assert.ok(await card.locator("footer").evaluate(node => node.matches(":last-child")));
        }
      }
      assert.equal(await page.locator('[data-single-slot="direct"] [data-single-counter]').textContent(), "Context!!!!!!!!!!:1");
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
      await page.evaluate(() => (window as any).finishPlain()); await settle();
      assert.equal(await page.locator("#mount").textContent(), "");
      assert.deepEqual(await page.evaluate(() => (window as any).singleDisposals), await page.evaluate(() => (window as any).singleMounts));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

const receivingApplication = (target: "react" | "preact", entry: string): string => `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { XReceivingPage, XReceivingList, XReceivingItem, XReceivingDetail, XReceivingOuter } from ${JSON.stringify(entry)};
function App() {
  const [label, setLabel] = React.useState("Before");
  React.useEffect(() => { window.plainHydrated = true; }, []);
  const children = <><XReceivingItem label={label} slots={{ detail: <XReceivingDetail /> }} /><i data-rejected>Rejected</i>Rejected</>;
  return <main><div data-receiving-case="compiled"><XReceivingPage /></div>{["native", "nested"].map(name => <div key={name} data-receiving-case={name}>
    <button data-receiving-update onClick={() => setLabel("After")}>Update</button>{name === "native" ? <XReceivingList>{children}</XReceivingList> : <XReceivingOuter><XReceivingList>{children}</XReceivingList></XReceivingOuter>}
  </div>)}<div data-receiving-empty><XReceivingList><i>Rejected</i>Rejected</XReceivingList></div></main>;
}`;

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} places accepted roots once through receiving-outlet transfers`, async () => {
  const application = (entry: string): string => receivingApplication(target, entry);
  const { directory, html, entry } = await plainSlotRendering(target, application);
  const browser = await launchParityBrowser(browserType);
  try {
    for (const hydrated of [false, true]) {
      const code = await build({ stdin: { contents: application(entry) + `
import { createRoot, hydrateRoot } from ${JSON.stringify(target === "react" ? "react-dom/client" : "preact/compat/client")};
window.plainRecovery = []; const app = <React.StrictMode><App /></React.StrictMode>;
const root = ${hydrated ? 'hydrateRoot(document.querySelector("#mount"), app, { onRecoverableError(error) { window.plainRecovery.push(error.message); } })' : 'createRoot(document.querySelector("#mount"))'};
${hydrated ? "" : "root.render(app);"} window.finishPlain = () => root.unmount();`, loader: "tsx", resolveDir: directory },
        bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}),
        loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const page = await browser.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.setContent(`<div id="mount">${hydrated ? html : ""}</div>`);
      const originals = new Map<string, ElementHandle<Node>>();
      for (const name of hydrated ? ["compiled", "native", "nested"] : []) {
        const input = page.locator(`[data-receiving-case="${name}"] input`);
        assert.equal(await input.count(), 1, `${name} server renders one source`);
        originals.set(name, (await input.elementHandle())!); await input.fill("Edited");
      }
      await page.addScriptTag({ content: code.outputFiles[0]!.text });
      await page.waitForFunction(() => (window as any).plainHydrated === true);
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle();
      assert.deepEqual(await page.locator("[data-receiving-empty] p, [data-receiving-empty] [data-receiving-list] > div").allTextContents(), ["FirstFallback", "SecondFallback"]);
      assert.equal(await page.locator("[data-receiving-empty] output").textContent(), "0");
      for (const name of ["compiled", "native", "nested"]) {
        const card = page.locator(`[data-receiving-case="${name}"]`), list = card.locator("[data-receiving-list]");
        const item = list.locator("[data-receiving-item]"), input = item.locator("input");
        assert.equal(await item.count(), 1, `${name} renders one source`);
        assert.equal(await list.locator("output").textContent(), "1");
        assert.equal(await list.locator("[data-rejected]").count(), 0);
        assert.ok(!(await list.textContent())!.includes("Rejected"));
        const original = originals.get(name) ?? (await input.elementHandle())!;
        assert.ok(await original.evaluate((node, name) => node === document.querySelector(`[data-receiving-case="${name}"] input`), name));
        await input.fill("Edited");
        const read = () => list.locator(":scope > p, :scope > div").evaluateAll(nodes => nodes.map(node => [node.localName, node.querySelector("[data-receiving-item] button")?.textContent ?? node.textContent]));
        const label = name === "nested" ? "After" : "Before";
        assert.deepEqual(await read(), [["p", `${label}:0:Tone`], ["div", "SecondFallback"]]);
        const kept = async (text: string): Promise<void> => {
          assert.equal(await item.count(), 1);
          assert.equal(await list.locator("output").textContent(), "1");
          assert.ok(await original.evaluate((node, name) => node === document.querySelector(`[data-receiving-case="${name}"] input`), name));
          assert.equal(await input.inputValue(), "Edited");
          assert.equal(await item.locator("button").textContent(), text);
        };
        await item.locator("button").click(); await settle(); await kept(`${label}:1:Tone`);
        await list.locator('[data-receiving-action="first"]').click(); await settle();
        assert.deepEqual(await read(), [["div", `${label}:1:Tone`]], `${name}: ${await list.innerHTML()}\n${errors.join("\n")}`); await kept(`${label}:1:Tone`);
        await list.locator('[data-receiving-action="second"]').click(); await settle();
        assert.equal(await item.count(), 0); assert.equal(await original.evaluate(node => node.isConnected), false);
        assert.equal(await list.locator("[data-receiving-borrowed] strong").textContent(), "1");
        await card.locator("[data-receiving-update]").click(); await settle();
        assert.equal(await list.locator("[data-receiving-borrowed] strong").textContent(), "1");
        await list.locator('[data-receiving-action="first"]').click(); await settle(); await kept("After:1:Tone");
        await list.locator('[data-receiving-action="second"]').click(); await settle();
        assert.deepEqual(await read(), [["p", "After:1:Tone"], ["div", "SecondFallback"]]); await kept("After:1:Tone");
        await item.locator("button").click(); await settle(); await kept("After:2:Tone");
        assert.ok(await list.locator("footer").evaluate(node => node.matches(":last-child")));
      }
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
      await page.evaluate(() => (window as any).finishPlain()); await settle();
      assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} retains hydrated native state, context and IDs through outlet removal`, async () => {
  const application = (entry: string): string => nativeApplication(target, entry);
  const { directory, html, entry } = await plainSlotRendering(target, application);
  const browser = await launchParityBrowser(browserType);
  try {
    const code = await build({ stdin: { contents: application(entry) + `
import { hydrateRoot } from ${JSON.stringify(target === "react" ? "react-dom/client" : "preact/compat/client")};
window.plainRecovery = []; const root = hydrateRoot(document.querySelector("#mount"), <React.StrictMode><App /></React.StrictMode>, { onRecoverableError(error) { window.plainRecovery.push(error.message); } });
window.finishPlain = () => root.unmount();`, loader: "tsx", resolveDir: directory },
      bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}),
      loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
    const page = await browser.newPage(), errors: string[] = [];
    const state = page.locator("[data-native-state]");
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setContent(`<div id="mount">${html}</div>`);
    const original = await page.locator("input").elementHandle(), id = await page.locator("[data-native-counter]").getAttribute("id");
    const originalCounter = await page.locator("[data-native-counter]").elementHandle();
    await page.locator("input").fill("Edited");
    await page.addScriptTag({ content: code.outputFiles[0]!.text });
    await page.waitForFunction(() => (window as any).plainHydrated === true && (window as any).plainMounts > 0);
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await settle();
    let mounts = await page.evaluate(() => (window as any).plainMounts);
    const retained = async (text: string): Promise<void> => {
      await settle();
      assert.ok(await original!.evaluate(node => node === document.querySelector("input")));
      assert.equal(await page.locator("input").inputValue(), "Edited");
      assert.equal(await page.locator("[data-native-counter]").getAttribute("id"), id);
      assert.equal(await page.locator("[data-native-counter]").textContent(), text);
      assert.equal(await page.evaluate(() => (window as any).plainMounts), mounts);
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
      assert.deepEqual(errors, []);
    };
    await retained("Context:0");
    await page.locator("[data-native-counter]").click();
    await retained("Context:1");
    for (const action of ["borrowed", "borrowed", "root", "root"]) {
      await state.locator(`[data-plain-action="${action}"]`).click();
      await retained("Context:1");
    }
    await page.locator("[data-native-context]").click();
    await page.locator("[data-native-counter]").click();
    await retained("Context!:2");
    for (const count of [0, 1]) {
      await page.locator("[data-native-source]").click();
      await retained("Context!:2");
      assert.equal(await page.locator("[data-native-content]").count(), count);
    }
    await state.locator('[data-plain-action="borrowed"]').click();
    await state.locator('[data-plain-action="root"]').click();
    await settle();
    assert.equal(await page.locator("input").count(), 0);
    await page.locator("[data-native-context]").click();
    await originalCounter!.evaluate(node => (node as HTMLButtonElement).click());
    await state.locator('[data-plain-action="root"]').click();
    await retained("Context!!:3");
    const pure = () => page.locator("[data-native-empty] [data-moving-plain] > p, [data-native-empty] [data-moving-plain] > b").allTextContents();
    assert.deepEqual(await pure(), ["Plain", "OwnFallback"]);
    await page.locator("[data-native-pure]").click();
    await settle();
    assert.deepEqual(await pure(), ["BorrowedFallback", "OwnFallback"]);
    await page.locator("[data-native-pure]").click();
    await settle();
    assert.deepEqual(await pure(), ["Plain", "OwnFallback"]);
    await retained("Context!!:3");
    if (target === "react") {
      await page.locator("[data-native-owner]").click();
      await settle();
      assert.equal(await state.isVisible(), false);
      await page.locator("[data-native-owner]").click();
      await settle();
      assert.equal(await state.isVisible(), true);
      mounts = await page.evaluate(() => (window as any).controlMounts);
      assert.equal(await page.evaluate(() => (window as any).plainDisposals), await page.evaluate(() => (window as any).controlDisposals));
      await retained("Context!!:3");
      assert.equal(await page.evaluate(() => (window as any).plainMounts - (window as any).plainDisposals), 1);
    }
    assert.ok(await page.locator("main > footer").evaluate(node => node.matches(":last-child")));
    await page.evaluate(() => (window as any).finishPlain());
    await settle();
    assert.equal(await page.locator("#mount").textContent(), "");
    assert.equal(await page.evaluate(() => (window as any).plainDisposals), mounts);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
