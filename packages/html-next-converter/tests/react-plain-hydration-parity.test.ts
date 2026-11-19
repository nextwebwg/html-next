import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { plainSlotExpected } from "../../html-next/tests/fixtures/plain-slot-ownership.js";
import { plainSlotRendering } from "./fixtures/plain-slot-rendering.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
for (const target of ["react", "preact"] as const) for (const mode of ["development", "production"] as const) it.skipIf(!enabled)(`Chromium ${target} ${mode} keeps scalar projection outside adjacent touch targets`, async () => {
  const application = (entry: string): string => `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { XTextButton } from ${JSON.stringify(entry)};
function Label() { return <strong>Save changes</strong>; }
function App() {
  const [rich, setRich] = React.useState(false), [link, setLink] = React.useState(false), [kind, setKind] = React.useState("text"), [copies, setCopies] = React.useState(0);
  React.useLayoutEffect(() => { window.setPlainRich = setRich; window.setPlainLink = setLink; window.setPlainKind = setKind; window.setPlainCopies = setCopies; window.plainReady = true; });
  return <><div className="pair"><XTextButton id="primary" link={link} onClickCapture={() => window.plainOrder.push("capture")} onClick={() => { window.primaryCalls++; window.plainOrder.push("bubble"); }}>
    {rich ? <b onClick={event => { window.richCalls++; window.plainOrder.push("child"); if (window.stopPlain) event.stopPropagation(); }} onKeyDown={() => window.keyCalls++}>Save changes</b>
      : kind === "strong" ? <strong>Save changes</strong> : kind === "opaque" ? <Label /> : <>{"Save"}{" changes"}</>}
  </XTextButton><button id="more" type="button" aria-label="More options" /></div>
  <aside>{Array.from({length: copies}, (_, index) => <XTextButton key={index}><strong>Copy</strong></XTextButton>)}</aside></>;
}`;
  const { directory, html, entry } = await plainSlotRendering(target, application);
  const browser = await launchParityBrowser(chromium);
  try {
    const code = await build({ stdin: { contents: application(entry) + `
import { createRoot, hydrateRoot } from ${JSON.stringify(target === "react" ? "react-dom/client" : "preact/compat/client")};
window.primaryCalls = 0; window.richCalls = 0; window.keyCalls = 0; window.plainOrder = [];
const app = <React.StrictMode><App /></React.StrictMode>;
createRoot(document.querySelector("#reference"));
const root = window.plainMount;
const view = root.hasChildNodes() ? hydrateRoot(root, app) : createRoot(root);
if (!root.hasChildNodes()) view.render(app);
window.hidePlain = () => view.render(null); window.showPlain = () => view.render(app);`, loader: "tsx", resolveDir: directory },
      bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}),
      define: { "process.env.NODE_ENV": JSON.stringify(mode) }, loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
    for (const hydrated of [false, true]) for (const shadow of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:48px}.pair{display:flex;align-items:stretch;padding-block:16px}
#primary,#more{box-sizing:border-box;height:32px;border:1px solid #aaa;font:14px "Times New Roman";cursor:pointer}
#primary{display:inline-flex;align-items:center;width:94px;padding:0 8px}#more{position:relative;width:32px;padding:0}
#more::after{content:"";position:absolute;left:50%;top:50%;width:100%;height:56px;transform:translate(-50%,-50%)}</style>
</head><body><div id="mount">${hydrated ? html : ""}</div><div id="reference"></div><div id="shadow"></div></body></html>`);
      await page.evaluate(shadow => {
        const mount = document.querySelector("#mount")!;
        if (shadow) {
          const root = document.querySelector("#shadow")!.attachShadow({ mode: "open" });
          root.append(document.querySelector("style")!.cloneNode(true), mount);
        }
        Reflect.set(window, "plainMount", mount);
      }, shadow);
      await page.addScriptTag({ content: code.outputFiles[0]!.text });
      await page.waitForFunction(() => (window as any).plainReady === true);
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const tap = async () => {
        await settle();
        const point = await page.locator("#primary").evaluate(element => {
          const rect = element.getBoundingClientRect(), point = { x: rect.right - 2, y: rect.y + rect.height / 2 };
          if ((element.getRootNode() as Document | ShadowRoot).elementFromPoint(point.x, point.y)?.closest("button,a")?.id !== "primary") throw new Error("Primary edge belongs to its own control.");
          return point;
        });
        const before = await page.evaluate(() => (window as any).primaryCalls);
        await page.touchscreen.tap(point.x, point.y);
        assert.equal(await page.evaluate(() => (window as any).primaryCalls), before + 1, `${target}/${mode}/hydrated=${hydrated}: the primary edge activates its own control`);
      };
      await tap();
      await page.evaluate(() => (window as any).setPlainLink(true)); await settle();
      assert.equal(await page.locator("#primary").evaluate(element => element.localName), "a");
      assert.equal(await page.locator("#primary .caption").textContent(), "Save changes");
      await tap();
      for (const kind of ["strong", "opaque"]) {
        await page.evaluate(kind => (window as any).setPlainKind(kind), kind); await tap();
      }
      await page.evaluate(() => (window as any).setPlainRich(true)); await settle();
      await page.evaluate(() => { (window as any).plainOrder = []; });
      await page.locator("#primary b").click();
      assert.equal(await page.evaluate(() => (window as any).richCalls), 1, "interactive projection receives one synthetic click");
      assert.deepEqual(await page.evaluate(() => (window as any).plainOrder), ["capture", "child", "bubble"]);
      await page.locator("#primary b").evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: false })));
      assert.equal(await page.evaluate(() => (window as any).keyCalls), 1, "non-composed events reach the owner inside its native root");
      await page.evaluate(() => { (window as any).plainOrder = []; (window as any).stopPlain = true; });
      await page.locator("#primary b").click();
      assert.deepEqual(await page.evaluate(() => (window as any).plainOrder), ["capture", "child"], "synthetic cancellation stops ancestor handlers");
      await page.evaluate(() => { (window as any).stopPlain = false; (window as any).setPlainKind("text"); });
      await page.evaluate(() => (window as any).setPlainRich(false)); await settle();
      await tap();
      await page.evaluate(() => (window as any).setPlainRich(true)); await settle();
      await page.locator("#primary b").click();
      assert.equal(await page.evaluate(() => (window as any).richCalls), 3, "the event bridge returns with interactive content");
      const debug = await page.context().newCDPSession(page);
      const listeners = async (expression: string) => {
        const value = await debug.send("Runtime.evaluate", { expression });
        return (await debug.send("DOMDebugger.getEventListeners", { objectId: value.result.objectId! })).listeners.filter(listener => listener.type === "mousemove").length;
      };
      const baseline = await listeners('document.querySelector("#reference")'), active = await listeners("window.plainMount");
      assert.equal(await listeners('window.plainMount.querySelector(".caption")'), 0, "noninteractive outlet parents receive no delegated mouse listeners");
      await page.evaluate(() => (window as any).setPlainCopies(40)); await settle();
      assert.equal(await listeners("window.plainMount"), active, "more projections share the existing native delegates");
      await page.evaluate(() => (window as any).hidePlain()); await settle();
      assert.equal(await listeners("window.plainMount"), baseline, "unmount removes the projection delegates");
      await page.evaluate(() => (window as any).showPlain()); await settle();
      assert.equal(await listeners("window.plainMount"), active);
      await page.evaluate(() => (window as any).hidePlain()); await settle();
      assert.equal(await listeners("window.plainMount"), baseline);
      await debug.detach();
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} hydrates shared plain output without losing native edits`, async () => {
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
    await page.locator("[data-repeated-plain] input").fill("Before hydration");
    await page.addScriptTag({ content: code.outputFiles[0]!.text });
    await page.waitForFunction(() => (window as any).plainHydrated === true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
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
  const context = React.useContext(Context);
  const [count, setCount] = React.useState(0), [shown, setShown] = React.useState(true);
  return <>{shown && <i data-native-content>Native</i>}<input defaultValue="Initial" /><button data-native-counter onClick={() => setCount(value => value + 1)}>{context}:{count}</button><button data-native-source onClick={() => setShown(value => !value)}>Source</button></>;
}
function App() {
  const [context, setContext] = React.useState("Context"), [pure, setPure] = React.useState(true), [visible, setVisible] = React.useState(true);
  React.useEffect(() => { window.plainHydrated = true; }, []);
  return <Context.Provider value={context}><main><button data-native-context onClick={() => setContext(value => value + "!")}>Context</button>
    ${target === "react" ? '<button data-native-owner onClick={() => setVisible(value => !value)}>Owner</button><React.Activity mode={visible ? "visible" : "hidden"}>' : ""}
    <div data-native-state><XMovingList><XMovingColumn slots={{ cell: <React.Suspense fallback="Wait"><Counter /></React.Suspense> }} /></XMovingList></div>${target === "react" ? '</React.Activity>' : ""}
    <div data-native-empty><button data-native-pure onClick={() => setPure(value => !value)}>Pure</button><XMovingList><XMovingColumn slots={{ cell: pure && "Plain" }} /></XMovingList></div>
    <footer>Tail</footer></main></Context.Provider>;
}`;

const conditionalApplication = (target: "react" | "preact", entry: string): string => `import React from ${JSON.stringify(target === "react" ? "react" : "preact/compat")};
import { XSingleDirect, XSingleAncestor, XSingleMatch, XSingleClosed, XSingleLazyPage } from ${JSON.stringify(entry)};
const Context = React.createContext("Default");
function Counter() {
  const context = React.useContext(Context), [count, setCount] = React.useState(0);
  return <><input defaultValue="Initial" /><button data-single-counter onClick={() => setCount(value => value + 1)}>{context}:{count}</button></>;
}
function App() {
  const [context, setContext] = React.useState("Context");
  React.useEffect(() => { window.plainHydrated = true; }, []);
  return <Context.Provider value={context}><main><button data-single-context onClick={() => setContext(value => value + "!")}>Context</button>
    <XSingleDirect><Counter /></XSingleDirect><XSingleAncestor><Counter /></XSingleAncestor>
    <XSingleMatch><Counter /></XSingleMatch><XSingleClosed><Counter /></XSingleClosed><XSingleLazyPage />
  </main></Context.Provider>;
}`;

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} renders interactive native content through single conditional outlets`, async () => {
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
      for (const name of hydrated ? ["direct", "ancestor", "match"] : []) {
        await page.locator(`[data-single-slot="${name}"] input`).fill("Edited");
      }
      await page.addScriptTag({ content: code.outputFiles[0]!.text });
      await page.waitForFunction(() => (window as any).plainHydrated === true);
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle();
      for (const name of ["direct", "ancestor", "match", "closed", "lazy"]) {
        const card = page.locator(`[data-single-slot="${name}"]`), input = card.locator("input"), toggle = card.locator("[data-single-toggle]");
        if (name === "closed") { assert.equal(await input.count(), 0); await toggle.click(); await settle(); }
        if (hydrated && ["direct", "ancestor", "match"].includes(name)) assert.equal(await input.inputValue(), "Edited");
        const counter = card.locator("[data-single-counter]");
        const interact = async () => {
          await input.fill("Edited");
          assert.equal(await input.inputValue(), "Edited");
          assert.ok(await input.evaluate(node => node === node.ownerDocument.activeElement));
          if (name !== "lazy") {
            const before = (await counter.textContent())!, count = Number(before.split(":").at(-1));
            await counter.click(); await settle();
            assert.equal(await counter.textContent(), before.slice(0, before.lastIndexOf(":") + 1) + (count + 1));
          }
        };
        await interact();
        for (let cycle = 0; cycle < 2; cycle++) {
          await toggle.click(); await settle();
          assert.equal(await input.count(), 0);
          await page.locator("[data-single-context]").click(); await settle();
          await toggle.click(); await settle();
          await interact();
          assert.ok(await card.locator("footer").evaluate(node => node.matches(":last-child")));
        }
      }
      assert.match((await page.locator('[data-single-slot="direct"] [data-single-counter]').textContent())!, /^Context!!!!!!!!!!:\d+$/);
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
      await page.evaluate(() => (window as any).finishPlain()); await settle();
      assert.equal(await page.locator("#mount").textContent(), "");
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
      for (const name of hydrated ? ["compiled", "native", "nested"] : []) {
        const input = page.locator(`[data-receiving-case="${name}"] input`);
        assert.equal(await input.count(), 1, `${name} server renders one source`);
        await input.fill("Edited");
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
        if (hydrated) assert.equal(await input.inputValue(), "Edited");
        const read = () => list.locator(":scope > p, :scope > div").evaluateAll(nodes => nodes.map(node => [node.localName, node.querySelector("[data-receiving-item] button")?.textContent ?? node.textContent]));
        let label = name === "nested" ? "After" : "Before";
        assert.deepEqual(await read(), [["p", `${label}:0:Tone`], ["div", "SecondFallback"]]);
        const interact = async () => {
          assert.equal(await item.count(), 1); assert.equal(await list.locator("output").textContent(), "1");
          const button = item.locator("button"), text = (await button.textContent())!;
          assert.match(text, new RegExp(`^${label}:\\d+:Tone$`));
          const count = Number(text.split(":")[1]);
          await input.fill("Edited"); assert.equal(await input.inputValue(), "Edited");
          await button.click(); await settle();
          assert.equal(await button.textContent(), `${label}:${count + 1}:Tone`);
          assert.equal(await list.locator("[data-receiving-detail]").textContent(), String(count + 1));
        };
        await interact();
        await list.locator('[data-receiving-action="first"]').click(); await settle();
        assert.equal((await read())[0]![0], "div"); await interact();
        await list.locator('[data-receiving-action="second"]').click(); await settle();
        assert.equal(await item.count(), 0);
        await card.locator("[data-receiving-update]").click(); await settle(); label = "After";
        await list.locator('[data-receiving-action="first"]').click(); await settle(); await interact();
        await list.locator('[data-receiving-action="second"]').click(); await settle();
        assert.equal((await read())[1]![1], "SecondFallback"); await interact();
        assert.ok(await list.locator("footer").evaluate(node => node.matches(":last-child")));
      }
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []);
      await page.evaluate(() => (window as any).finishPlain()); await settle();
      assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

// Foreign components follow their framework's normal reconciliation. Exercise the live
// controls and context at each destination without demanding private instance retention.
for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of ["react", "preact"] as const) it.skipIf(!enabled)(`${engine} ${target} hydrates native controls and updates context through outlet changes`, async () => {
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
    await page.locator("input").fill("Edited");
    await page.addScriptTag({ content: code.outputFiles[0]!.text });
    await page.waitForFunction(() => (window as any).plainHydrated === true);
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await settle();
    assert.equal(await page.locator("input").inputValue(), "Edited");
    const interact = async (context: string) => {
      const input = page.locator("input"), counter = page.locator("[data-native-counter]");
      assert.equal(await input.count(), 1); assert.equal(await counter.count(), 1);
      const count = Number((await counter.textContent())!.split(":").at(-1));
      assert.equal(await counter.textContent(), `${context}:${count}`);
      await input.fill("Edited again");
      assert.equal(await input.inputValue(), "Edited again");
      assert.ok(await input.evaluate(node => node === node.ownerDocument.activeElement));
      await counter.click(); await settle(); assert.equal(await counter.textContent(), `${context}:${count + 1}`);
      assert.deepEqual(await page.evaluate(() => (window as any).plainRecovery), []); assert.deepEqual(errors, []);
    };
    await interact("Context");
    for (const action of ["borrowed", "borrowed", "root", "root"]) {
      await state.locator(`[data-plain-action="${action}"]`).click(); await settle(); await interact("Context");
    }
    await page.locator("[data-native-context]").click(); await settle(); await interact("Context!");
    for (const count of [0, 1]) {
      await page.locator("[data-native-source]").click(); await settle();
      assert.equal(await page.locator("[data-native-content]").count(), count); await interact("Context!");
    }
    await state.locator('[data-plain-action="borrowed"]').click();
    await state.locator('[data-plain-action="root"]').click(); await settle(); assert.equal(await page.locator("input").count(), 0);
    await page.locator("[data-native-context]").click(); await settle();
    await state.locator('[data-plain-action="root"]').click(); await settle(); await interact("Context!!");
    const pure = () => page.locator("[data-native-empty] [data-moving-plain] > p, [data-native-empty] [data-moving-plain] > b").allTextContents();
    assert.deepEqual(await pure(), ["Plain", "OwnFallback"]);
    await page.locator("[data-native-pure]").click(); await settle(); assert.deepEqual(await pure(), ["BorrowedFallback", "OwnFallback"]);
    await page.locator("[data-native-pure]").click(); await settle(); assert.deepEqual(await pure(), ["Plain", "OwnFallback"]);
    if (target === "react") {
      await page.locator("[data-native-owner]").click(); await settle(); assert.equal(await state.isVisible(), false);
      await page.locator("[data-native-owner]").click(); await settle(); assert.equal(await state.isVisible(), true); await interact("Context!!");
    }
    assert.ok(await page.locator("main > footer").evaluate(node => node.matches(":last-child")));
    await page.evaluate(() => (window as any).finishPlain()); await settle();
    assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
