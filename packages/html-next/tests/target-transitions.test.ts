import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const generatedRuntimePath = new URL("../src/generated-runtime.ts", import.meta.url).pathname;
const livePath = new URL("../src/live.ts", import.meta.url).pathname;

const source = `<template component="x-shelf" controller="./shelf-controller.js" status="early" summary="Transitions fixture.">
  <defs>
    <state name="open" type="boolean" value="false"></state>
    <state name="count" type="number" value="0"></state>
    <state name="items" type="list(object({ id: string, label: string }))" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]"></state>
  </defs>
  <section>
    <aside $if="$open" $transition="fly 300ms">Panel</aside>
    <output $value="$count"></output>
    <ul><li $each="item of $items" $key="$item.id" $transition="fade 300ms">{$item.label}</li></ul>
  </section>
</template>`;

const engines: readonly (readonly [string, BrowserType])[] = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];

/**
 * The page counts every view transition the components start, and reads which animations each
 * one plays: the pseudo-element, the keyframes and the duration.
 */
const instrument = `
  window.transitions = [];
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = (update) => { const transition = start(update); window.transitions.push(transition); return transition; };
  window.played = async (transition) => {
    await transition.ready;
    return document.documentElement.getAnimations({ subtree: true })
      .filter((animation) => animation.effect.pseudoElement && /^hn-/.test(animation.animationName))
      .map((animation) => [animation.effect.pseudoElement.replace(/\\(.*\\)/, ""), animation.animationName,
        Math.round(animation.effect.getComputedTiming().duration), animation.effect.getComputedTiming().direction])
      .sort();
  };
`;

describe.skipIf(!enabled)("transitions extension in compiled output", () => {
  let directory = "";
  let bundle = "";
  let live = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-transitions-"));
    for (const artifact of generateComponent(parseComponent(source, "x-shelf.html"), { extensions: ["transitions"] })) {
      await mkdir(join(directory, artifact.path, ".."), { recursive: true });
      await writeFile(join(directory, artifact.path), artifact.content);
    }
    await writeFile(join(directory, "vanilla", "shelf-controller.js"), "export default function controller(host) { (window.hosts ??= []).push(host); }\n");
    await writeFile(join(directory, "entry.ts"), `import { createXShelf } from "./vanilla/XShelf.js";
      document.querySelector("main").append(createXShelf(), createXShelf());`);
    bundle = join(directory, "entry.js");
    await build({
      entryPoints: [join(directory, "entry.ts")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], loader: { ".css": "empty" },
      define: { "import.meta.url": JSON.stringify("https://example.test/generated/component.js") },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath },
    });
    live = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: live, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  const open = async (type: BrowserType, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<{ page: Page; close: () => Promise<void> }> => {
    const browser = await type.launch({ headless: true });
    const page = await browser.newPage({ reducedMotion });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: instrument });
    await page.addScriptTag({ path: bundle });
    await page.waitForFunction(() => (window as unknown as { hosts?: unknown[] }).hosts?.length === 2);
    return { page, close: async () => { assert.deepEqual(errors, []); await browser.close(); } };
  };

  for (const [name, type] of engines) {
    it(`${name}: animates what a structural directive adds, removes and moves, and only that`, async () => {
      const { page, close } = await open(type);
      try {
        const result = await page.evaluate(async () => {
          type Host = { state: { open: boolean; count: number; items: { id: string; label: string }[] } };
          const w = window as unknown as { hosts: Host[]; transitions: ViewTransition[]; played: (transition: ViewTransition) => Promise<unknown[]> };
          const [first, second] = w.hosts as [Host, Host];
          const asides = () => document.querySelectorAll("aside").length;
          const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
          const settle = async () => { await w.transitions.at(-1)?.finished; await tick(); };
          // A held flush starts its transition in the scheduler's microtask, after the write.
          const next = async () => { await Promise.resolve(); return w.transitions.at(-1)!; };
          const out: Record<string, unknown> = {};

          // Both instances open in one task: one transition holds both, and the DOM waits for it.
          first.state.open = true;
          second.state.open = true;
          await Promise.resolve();
          out.heldBeforeCapture = asides();
          out.arriving = await w.played(w.transitions[0]!);
          out.transitionsForOneTask = w.transitions.length;
          out.shownInside = asides();
          await settle();

          first.state.open = false;
          out.leaving = await w.played(await next());
          await settle();

          // A change no participating region reads updates at once, with no transition.
          const before = w.transitions.length;
          first.state.count = 5;
          await tick();
          out.unrelated = [w.transitions.length - before, document.querySelector("output")!.textContent];

          first.state.items = [...first.state.items].reverse();
          out.moving = await w.played(await next());
          await settle();

          first.state.items.push({ id: "d", label: "D" });
          out.pushed = await w.played(await next());
          await settle();

          // A nested write that adds, removes and moves nothing skips its transition.
          first.state.items[0]!.label = "Z";
          const edit = await next();
          out.edit = [await edit.ready.then(() => "played", () => "skipped"), document.querySelector("li")!.textContent];
          await settle();

          out.sheetsAfter = document.adoptedStyleSheets.length;
          out.names = [...document.querySelectorAll("li")].slice(0, 2).map((li) => [li.style.getPropertyValue("view-transition-name"), /^hn-t/.test(li.style.getPropertyValue("view-transition-class"))]);
          return out;
        });
        assert.equal(result.heldBeforeCapture, 0);
        assert.equal(result.transitionsForOneTask, 1);
        assert.equal(result.shownInside, 2);
        assert.deepEqual(result.arriving, [["::view-transition-new", "hn-fly", 300, "normal"], ["::view-transition-new", "hn-fly", 300, "normal"]]);
        assert.deepEqual(result.leaving, [["::view-transition-old", "hn-fly", 300, "reverse"]]);
        assert.deepEqual(result.unrelated, [0, "5"]);
        // Moved rows animate as the browser's own move; the moving rows' names carry no keyframes.
        assert.deepEqual(result.moving, []);
        assert.deepEqual(result.pushed, [["::view-transition-new", "hn-fade", 300, "normal"]]);
        assert.deepEqual(result.edit, ["skipped", "Z"]);
        assert.equal(result.sheetsAfter, 1);
        assert.deepEqual(result.names, [["match-element", true], ["match-element", true]]);
      } finally {
        await close();
      }
    });

    it(`${name}: retimes the browser's move to the value's duration`, async () => {
      const { page, close } = await open(type);
      try {
        const groups = await page.evaluate(async () => {
          const w = window as unknown as { hosts: { state: { items: unknown[] } }[]; transitions: ViewTransition[] };
          w.hosts[0]!.state.items = [...w.hosts[0]!.state.items].reverse();
          await Promise.resolve();
          const transition = w.transitions.at(-1)!;
          await transition.ready;
          const durations = document.documentElement.getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.pseudoElement?.startsWith("::view-transition-group("))
            .map((animation) => Math.round(animation.effect!.getComputedTiming().duration as number));
          await transition.finished;
          return durations;
        });
        assert.ok(groups.length >= 2, `moved rows animate: ${JSON.stringify(groups)}`);
        assert.ok(groups.every((duration) => duration === 300), JSON.stringify(groups));
      } finally {
        await close();
      }
    });

    it(`${name}: updates at once, without a transition, when motion is reduced`, async () => {
      const { page, close } = await open(type, "reduce");
      try {
        const result = await page.evaluate(async () => {
          const w = window as unknown as { hosts: { state: { open: boolean } }[]; transitions: unknown[] };
          w.hosts[0]!.state.open = true;
          await Promise.resolve();
          return [w.transitions.length, document.querySelectorAll("aside").length];
        });
        assert.deepEqual(result, [0, 1]);
      } finally {
        await close();
      }
    });
  }

  it("the live runtime warns once and renders without animation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const warnings: string[] = [];
      page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
      await page.setContent(`<template component="x-live" status="early" summary="Live.">
        <defs><state name="open" type="boolean" value="true"></state></defs>
        <div><p $if="$open" $transition="fade">Shown</p></div></template><x-live></x-live><x-live></x-live>`);
      await page.addScriptTag({ path: live });
      await page.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
      await page.waitForSelector("[data-component~='x-live'] p", { state: "attached" });
      assert.deepEqual(warnings.filter((text) => text.includes("HT024")).length, 1);
      assert.match(warnings.find((text) => text.includes("HT024"))!, /live runtime does not support; `x-live` renders without animation/);
    } finally {
      await browser.close();
    }
  });
});
