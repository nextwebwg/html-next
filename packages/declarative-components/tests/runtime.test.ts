import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { transformComponentStyles } from "../src/style.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./runtime.html", import.meta.url);
const runtimeUrl = new URL("../src/runtime.ts", import.meta.url);

describe.skipIf(!enabled)("browser runtime", () => {
  let bundlePath = "";
  let temporaryDirectory = "";
  let source = "";

  beforeAll(async () => {
    source = await readFile(fixtureUrl, "utf8");
    const runtimeSource = await readFile(runtimeUrl, "utf8");
    assert.doesNotMatch(runtimeSource, /\beval\s*\(|new\s+Function\s*\(|customElements\.define\s*\(/);

    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-runtime-"));
    bundlePath = join(temporaryDirectory, "runtime.js");
    await build({
      entryPoints: [runtimeUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlRuntime",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
  });

  afterAll(async () => {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name} can leave application-owned roots out of document observation`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="observed-card" status="early" summary="Observation filter fixture.">' +
          '<article><slot></slot></article></template>' +
          '<main><article id="owned" data-component-root="observed-card" data-owned>Owned</article></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const stop = window.HtmlRuntime.observeDocument(document, {
            shouldLower: (element, _definition, hydration) =>
              !(hydration && element.hasAttribute("data-owned")),
          });
          const live = document.createElement("observed-card");
          live.textContent = "Live";
          document.querySelector("main").append(live);
          await new Promise(resolve => setTimeout(resolve, 0));
          const owned = document.querySelector("#owned");
          const lowered = document.querySelector("main > article:not(#owned)");
          const result = {
            ownedText: owned.textContent,
            ownedMarked: owned.hasAttribute("data-owned"),
            loweredTag: lowered?.localName,
            loweredText: lowered?.textContent,
          };
          stop();
          return result;
        })()`);
        assert.deepEqual(result, {
          ownedText: "Owned",
          ownedMarked: true,
          loweredTag: "article",
          loweredText: "Live",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} attaches framework roots through the registered declarative contract`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="registered-button" status="early" summary="Registered adapter fixture.">' +
          '<defs><prop name="label" type="string" default="">Accessible label.</prop>' +
          '<prop name="payload" type="object({ value: string }) | null">Structured payload.</prop></defs>' +
          '<button :aria-label="label" .payload="payload"><slot></slot></button></template><main></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const root = document.createElement("button");
          root.textContent = "Save";
          document.querySelector("main").append(root);
          const detach = window.HtmlRuntime.attachRegisteredComponent(
            root,
            "registered-button",
            { props: { label: "Save changes", payload: null } },
          );
          const result = {
            root: root.localName,
            label: root.getAttribute("aria-label"),
            payload: root.payload,
            reflectedPayload: root.hasAttribute("data-payload"),
            text: root.textContent,
            customElement: customElements.get("registered-button") !== undefined,
          };
          detach();
          return result;
        })()`);
        assert.deepEqual(result, {
          root: "button",
          label: "Save changes",
          payload: null,
          reflectedPayload: false,
          text: "Save",
          customElement: false,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} parses and lowers components owned by another browser realm`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          const frame = document.createElement("iframe");
          document.querySelector("main").append(frame);
          const frameDocument = frame.contentDocument;
          frameDocument.open();
          frameDocument.write('<template component="realm-button" status="early" summary="Cross-realm fixture."><button><slot></slot></button></template><realm-button id="realm">Realm</realm-button>');
          frameDocument.close();
          const stop = window.HtmlRuntime.observeDocument(frameDocument);
          const result = {
            localName: frameDocument.querySelector("#realm").localName,
            text: frameDocument.querySelector("#realm").textContent,
          };
          stop();
          frame.remove();
          return result;
        })()`);
        assert.deepEqual(result, { localName: "button", text: "Realm" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers later declarative instances without rescanning the document`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="demo-local" status="early" summary="Local mutation fixture."><button><slot></slot></button></template>' +
          '<template component="demo-unused-a" status="early" summary="Unused A."><span></span></template>' +
          '<template component="demo-unused-b" status="early" summary="Unused B."><span></span></template>' +
          '<main></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const stop = window.HtmlRuntime.observeDocument();
          const nativeQuery = Document.prototype.querySelectorAll;
          const nativeElementQuery = Element.prototype.querySelectorAll;
          let documentQueries = 0;
          let wildcardQueries = 0;
          let rootMarkerQueries = 0;
          let discoveryQueries = 0;
          let registryScans = 0;
          const nativeMapKeys = Map.prototype.keys;
          const nativeMapValues = Map.prototype.values;
          Map.prototype.keys = function() {
            registryScans += 1;
            return nativeMapKeys.call(this);
          };
          Map.prototype.values = function() {
            registryScans += 1;
            return nativeMapValues.call(this);
          };
          Document.prototype.querySelectorAll = function(selector) {
            if (this === document) documentQueries += 1;
            return nativeQuery.call(this, selector);
          };
          Element.prototype.querySelectorAll = function(selector) {
            if (selector === "*") wildcardQueries += 1;
            if (selector === "[data-component-root]") rootMarkerQueries += 1;
            if (["template[component]", "[data-component-root]", "demo-local", "demo-unused-a", "demo-unused-b"].every(part => selector.includes(part))) {
              discoveryQueries += 1;
            }
            return nativeElementQuery.call(this, selector);
          };
          const section = document.createElement("section");
          section.innerHTML = '<demo-local id="local">Local</demo-local>';
          document.querySelector("main").append(section);
          await tick();
          const localName = document.querySelector("#local").localName;
          Document.prototype.querySelectorAll = nativeQuery;
          Element.prototype.querySelectorAll = nativeElementQuery;
          Map.prototype.keys = nativeMapKeys;
          Map.prototype.values = nativeMapValues;
          stop();
          return { documentQueries, wildcardQueries, rootMarkerQueries, discoveryQueries, registryScans, localName };
        })()`) as {
          documentQueries: number;
          wildcardQueries: number;
          rootMarkerQueries: number;
          discoveryQueries: number;
          registryScans: number;
          localName: string;
        };
        assert.equal(result.documentQueries, 0);
        assert.equal(result.wildcardQueries, 0);
        assert.equal(result.rootMarkerQueries, 0);
        assert.equal(result.discoveryQueries, 2);
        assert.equal(result.registryScans, 0);
        assert.equal(result.localName, "button");
      } finally {
        await browser.close();
      }
    });

    it(`${name} shares one mutation observer across live and generated components`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const NativeObserver = window.MutationObserver;
          let documentObservers = 0;
          window.MutationObserver = class extends NativeObserver {
            observe(target, options) {
              if (target instanceof Document) documentObservers += 1;
              return super.observe(target, options);
            }
          };
          const stopDocument = window.HtmlRuntime.observeDocument();
          const definition = {
            contract: { version: 1, name: "DemoManaged", tag: "demo-managed", status: "early",
              summary: "Managed lifecycle fixture.", nativeElement: "button", props: {} },
            template: { kind: "element", name: "button", attributes: [], children: [] },
            css: "", declarations: [], slots: [],
            root: { kind: "native", element: "button", choices: ["button"] },
          };
          const first = document.createElement("button");
          const second = document.createElement("button");
          const stopFirst = window.HtmlRuntime.manageComponentLifecycle(first, definition);
          const stopSecond = window.HtmlRuntime.manageComponentLifecycle(second, definition);
          document.querySelector("main").append(first, second);
          await tick();
          const connected = [first, second].every(element => window.HtmlRuntime.getComponentHost(element) != null);
          const events = [];
          const host = window.HtmlRuntime.getComponentHost(first);
          const privateState = first[Symbol.for("@nextwebwg/declarative-components.runtime.v1")] === undefined;
          const frozenHost = Object.isFrozen(host);
          host.on("connect", () => events.push("connect"));
          host.on("disconnect", () => events.push("disconnect"));
          first.remove();
          await tick();
          document.querySelector("main").append(first);
          await tick();
          stopDocument();
          stopFirst();
          stopSecond();
          return { documentObservers, connected, events, privateState, frozenHost };
        })()`);
        assert.deepEqual(result, {
          documentObservers: 1,
          connected: true,
          events: ["connect", "disconnect", "connect", "disconnect"],
          privateState: true,
          frozenHost: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} observes later definitions and instances with balanced connection cleanup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main><aside></aside>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const events = [];
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onConnect(element, definition) {
              events.push("connect:" + element.id + ":" + (definition.controller ?? "none"));
              return () => events.push("dispose:" + element.id);
            },
            onError(error) { errors.push(error.diagnostic?.code ?? error.message); },
          });
          document.querySelector("main").innerHTML = '<demo-dynamic id="first">First</demo-dynamic>';
          await tick();
          const pending = document.querySelector("#first").localName;
          const definition = document.createElement("template");
          definition.setAttribute("component", "demo-dynamic");
          definition.setAttribute("status", "early");
          definition.setAttribute("summary", "Dynamic test component.");
          definition.setAttribute("controller", "./dynamic.js");
          definition.innerHTML = '<button><slot></slot></button><style id="once">button { color: red; }</style>';
          document.body.append(definition);
          await tick();
          const first = document.querySelector("#first");
          const lowered = first.localName;
          document.querySelector("aside").append(first);
          await tick();
          const afterMove = [...events];
          first.remove();
          await tick();
          document.querySelector("main").append(first);
          await tick();
          document.querySelector("main").insertAdjacentHTML("beforeend", '<demo-dynamic id="second">Second</demo-dynamic>');
          await tick();
          const second = document.querySelector("#second").localName;
          const sameFirst = first === document.querySelector("#first");
          stop(); stop();
          document.body.insertAdjacentHTML("beforeend", '<demo-dynamic id="stopped"></demo-dynamic>');
          await tick();
          return { pending, lowered, second, sameFirst, afterMove, events, errors,
            styles: document.querySelectorAll("#once").length,
            stopped: document.querySelector("#stopped").localName };
        })()`);
        assert.deepEqual(result, {
          pending: "demo-dynamic", lowered: "button", second: "button", sameFirst: true,
          afterMove: ["connect:first:./dynamic.js"],
          events: ["connect:first:./dynamic.js", "dispose:first", "connect:first:./dynamic.js",
            "connect:second:./dynamic.js", "dispose:first", "dispose:second"],
          errors: [], styles: 1, stopped: "demo-dynamic",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} can stop observation from a connection callback without leaking cleanup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-stop" status="early" summary="Stop."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const events = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onConnect(element) {
              events.push("connect:" + element.id);
              stop();
              return () => events.push("dispose:" + element.id);
            },
          });
          document.body.insertAdjacentHTML("beforeend", '<demo-stop id="one"></demo-stop><demo-stop id="two"></demo-stop>');
          await new Promise(resolve => setTimeout(resolve, 0));
          stop();
          return events;
        })()`);
        assert.deepEqual(result, ["connect:one", "dispose:one"]);
      } finally {
        await browser.close();
      }
    });

    it(`${name} runs declarative lifecycle handlers again after reconnect`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-life" status="early" summary="Lifecycle.">` +
            `<defs><state name="count" :value="0"></state>` +
            `<handler name="connected"><set name="count" :value="count + 1"></set></handler>` +
            `<handler name="disconnected"><set name="count" :value="count + 10"></set></handler></defs>` +
            `<section on:connect="connected" on:disconnect="disconnected"><output $value="count"></output></section>` +
            `</template><x-life id="life"></x-life><aside></aside>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const stop = window.HtmlRuntime.observeDocument();
          await tick();
          const root = document.querySelector('#life');
          const initial = root.textContent;
          root.remove();
          await tick();
          document.querySelector('aside').append(root);
          await tick();
          await Promise.resolve();
          const reconnected = root.textContent;
          stop();
          return { initial, reconnected };
        })()`);
        assert.deepEqual(result, { initial: "1", reconnected: "12" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} retains duplicate rules and custom-element precedence after discovery`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-retained" status="early" summary="Retained."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onError(error) { errors.push(error.diagnostic.code); },
          });
          const duplicate = document.createElement("template");
          duplicate.setAttribute("component", "demo-retained");
          duplicate.setAttribute("status", "early");
          duplicate.setAttribute("summary", "Duplicate.");
          duplicate.innerHTML = "<span></span>";
          document.body.append(duplicate);
          await tick();
          duplicate.remove();
          customElements.define("demo-retained", class extends HTMLElement {});
          document.body.insertAdjacentHTML("beforeend", '<demo-retained id="owned"></demo-retained>');
          await tick();
          const owned = document.querySelector("#owned");
          stop();
          return { errors, name: owned.localName,
            nativeUpgrade: owned instanceof customElements.get("demo-retained") };
        })()`);
        assert.deepEqual(result, { errors: ["HR001"], name: "demo-retained", nativeUpgrade: true });
      } finally {
        await browser.close();
      }
    });

    it(`${name} never promotes dynamic inert or sanitized content into executable definitions`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-content" status="early" summary="Content."><defs><prop name="body" type="string">Content.</prop></defs><article $html="body"></article></template><template component="demo-safe" status="early" summary="Safe."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onError(error) { errors.push(error.diagnostic.code); },
          });
          const invalid = document.createElement("template");
          invalid.setAttribute("component", "demo-invalid");
          invalid.innerHTML = '<defs><script>window.executed = true</script></defs><button></button>';
          document.body.append(invalid);
          await tick();
          invalid.remove();
          const external = document.createElement("template");
          external.setAttribute("component", "demo-external");
          external.setAttribute("src", "https://unmapped.example/definition.html");
          document.body.append(external);
          await tick();
          external.remove();
          const content = document.createElement("demo-content");
          content.setAttribute("body", '<template component="demo-injected"><script>window.executed = true</script><button></button></template><demo-safe id="content-only"></demo-safe>');
          document.body.append(content);
          await tick();
          const contentOnly = document.querySelector("#content-only");
          document.body.append(contentOnly);
          await tick();
          stop();
          return { errors, executed: window.executed ?? false,
            definitions: document.querySelectorAll("template[component]").length,
            contentName: contentOnly.localName };
        })()`);
        assert.deepEqual(result, {
          errors: ["HT009", "HL001"], executed: false, definitions: 0, contentName: "demo-safe",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves the document when a later invocation is invalid`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const definitionMarkup =
          `<template component="demo-transactional-button" id="definition" status="early" summary="Transactional test component.">` +
          `<defs><prop name="label" type="string" required>Button label.</prop></defs>` +
          `<button :data-label="label"><slot></slot></button>` +
          `<style id="definition-style">button { color: red; }</style></template>`;
        await page.setContent(`${definitionMarkup}<main><demo-transactional-button id="first" label="first"><strong id="kept-child">First</strong></demo-transactional-button><demo-transactional-button id="second"></demo-transactional-button></main>`);
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(() => {
          const definition = document.querySelector("#definition");
          // A <template>'s <style> lives in its inert content fragment, not the light DOM.
          const style = definition.content.querySelector("#definition-style");
          const first = document.querySelector("#first");
          const second = document.querySelector("#second");
          const keptChild = document.querySelector("#kept-child");
          let diagnostic = "";
          try {
            window.HtmlRuntime.lowerDocument();
          } catch (error) {
            diagnostic = error.diagnostic.code;
          }
          const unchanged = {
            diagnostic,
            definitionConnected: definition.isConnected,
            styleStillInDefinition: definition.content.contains(style),
            firstUnchanged: document.querySelector("#first") === first,
            secondUnchanged: document.querySelector("#second") === second,
            keptChildUnchanged: document.querySelector("#kept-child") === keptChild,
          };

          second.setAttribute("label", "second");
          const lowered = window.HtmlRuntime.lowerDocument();
          const loweredFirst = document.querySelector("#first");
          return {
            unchanged,
            lowered,
            definitionRemoved: !definition.isConnected,
            styleMovedToHead: style.parentElement === document.head,
            firstIsButton: loweredFirst instanceof HTMLButtonElement,
            childIdentityPreserved: loweredFirst.querySelector("#kept-child") === keptChild,
          };
        })()`);

        assert.deepEqual(result, {
          unchanged: {
            diagnostic: "HC020",
            definitionConnected: true,
            styleStillInDefinition: true,
            firstUnchanged: true,
            secondUnchanged: true,
            keptChildUnchanged: true,
          },
          lowered: 2,
          definitionRemoved: true,
          styleMovedToHead: true,
          firstIsButton: true,
          childIdentityPreserved: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} rejects executable literal attributes and unsafe property sinks`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const diagnostic = async (source: string): Promise<string> => {
          await page.setContent(source);
          await page.addScriptTag({ path: bundlePath });
          return page.evaluate(`(() => {
            try {
              window.HtmlRuntime.lowerDocument();
              return "no diagnostic";
            } catch (error) {
              return error.diagnostic.code;
            }
          })()`);
        };
        const buttonMarkup =
          `<template component="demo-unsafe-button" status="early" summary="Unsafe test component.">` +
          `<button onclick="alert(1)"></button></template>`;
        const iframeMarkup =
          `<template component="demo-unsafe-frame" status="early" summary="Unsafe test component.">` +
          `<defs><prop name="markup" type="string">Embedded markup.</prop></defs>` +
          `<iframe :srcdoc="markup"></iframe></template>`;

        assert.equal(await diagnostic(buttonMarkup), "HT010");
        assert.equal(await diagnostic(iframeMarkup), "HT007");
      } finally {
        await browser.close();
      }
    });

    it(`${name} evaluates $value/$html and sanitizes $html markup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-note" status="early" summary="Note.">` +
            `<defs><prop name="body" type="string">Body markup.</prop>` +
            `<prop name="label" type="string" default="Note">Label.</prop></defs>` +
            `<article><h3 $value="label"></h3><div class="body" $html="body"></div></article>` +
            `</template>` +
            `<x-note id="n" label="Hi" body="<b>ok</b><script>window.__x=1</script><img src=x onerror=window.__x=2><a href='java&#x0A;script:window.__x=3'>bad</a><iframe srcdoc='&lt;script>window.parent.__x=4&lt;/script>'></iframe>"></x-note>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const note = document.querySelector("#n");
          const body = note.querySelector(".body");
          return {
            heading: note.querySelector("h3").textContent,
            hasBold: body.querySelector("b") !== null,
            scriptCount: body.querySelectorAll("script").length,
            onerror: body.querySelector("img")?.hasAttribute("onerror") ?? null,
            dangerousHref: body.querySelector("a")?.hasAttribute("href") ?? null,
            iframeCount: body.querySelectorAll("iframe").length,
            xflag: window.__x ?? "unset",
          };
        })()`);
        assert.deepEqual(result, {
          heading: "Hi",
          hasBold: true,
          scriptCount: 0,
          onerror: false,
          dangerousHref: false,
          iframeCount: 0,
          xflag: "unset",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} drops executable schemes from bound URL attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-link" status="early" summary="Link.">` +
            `<defs><prop name="destination" type="string">Destination.</prop></defs>` +
            `<a :href="destination"><slot></slot></a></template>` +
            `<x-link id="link" destination="java&#x0A;script:alert(1)">Open</x-link>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const hasHref = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          return document.getElementById("link")!.hasAttribute("href");
        });

        assert.equal(hasHref, false);
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders control flow: $each, $if, $match, $with`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-demo" status="early" summary="Control flow.">` +
            `<defs>` +
            `<prop name="tier" type="free | pro" default="free">Plan.</prop>` +
            `<prop name="show" type="boolean" default="false">Show.</prop>` +
            `</defs>` +
            `<div>` +
            `<ul class="nums"><li $each="n, i of [10, 20, 30]" $where="n > 10" :data-i="i" $value="n"></li></ul>` +
            `<p class="maybe" $if="show">extra</p>` +
            `<template $match="tier as t">` +
            `<span class="tier" $when="t = 'pro'">Pro</span>` +
            `<span class="tier" $else>Free</span>` +
            `</template>` +
            `<template $with="{ name: 'Ada' } as u"><b class="who" $value="u.name"></b></template>` +
            `</div></template>` +
            `<x-demo id="d" tier="pro"></x-demo>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#d");
          return {
            nums: Array.from(root.querySelectorAll(".nums li")).map((li) => [li.getAttribute("data-i"), li.textContent]),
            maybePresent: root.querySelector(".maybe") !== null,
            tier: root.querySelector(".tier")?.textContent ?? null,
            tierCount: root.querySelectorAll(".tier").length,
            who: root.querySelector(".who")?.textContent ?? null,
          };
        })()`);
        assert.deepEqual(result, {
          nums: [["0", "20"], ["1", "30"]], // $where drops 10; index is post-filter
          maybePresent: false, // show defaults false
          tier: "Pro",
          tierCount: 1, // only the winning arm renders
          who: "Ada",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} updates state, computed values, and bindings through declarative handlers`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-counter" status="early" summary="Counter.">` +
            `<defs>` +
            `<prop name="start" type="number" default="3">Start.</prop>` +
            `<state name="count" :value="start"></state>` +
            `<computed name="doubled" from="count * 2"></computed>` +
            `<data name="feed"></data>` +
            `<handler name="inc"><set name="count" :value="count + 1"></set></handler>` +
            `<handler name="ready"></handler>` +
            `</defs>` +
            `<div :data-count="count" :data-doubled="doubled">` +
            `<button on:click="inc" $value="count"></button>` +
            `<output bind:value="count"></output>` +
            `<i $value="feed.pending"></i>` +
            `<span on:connect="ready"></span>` +
            `</div></template>` +
            `<x-counter id="c" start="5"></x-counter>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#c");
          const snapshot = () => ({
            count: root.getAttribute("data-count"),
            doubled: root.getAttribute("data-doubled"),
            buttonText: root.querySelector("button").textContent,
            boundValue: root.querySelector("output").getAttribute("value"),
          });
          const initial = snapshot();
          root.querySelector("button").click();
          await Promise.resolve();
          return {
            initial,
            after: snapshot(),
            buttonHasOnClick: root.querySelector("button").hasAttribute("on:click"),
            pending: root.querySelector("i").textContent,
            spanHasOnConnect: root.querySelector("span").hasAttribute("on:connect"),
          };
        })()`);
        assert.deepEqual(result, {
          initial: { count: "5", doubled: "10", buttonText: "5", boundValue: "5" },
          after: { count: "6", doubled: "12", buttonText: "6", boundValue: "6" },
          buttonHasOnClick: false, // on: consumed, never emitted
          pending: "true", // data seeded in its pending shape
          spanHasOnConnect: false, // lifecycle consumed
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} writes text, checkbox, radio, select, and number controls back to state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-form" status="early" summary="Bindings.">` +
            `<defs><state name="form" :value="{ text: 'a', checked: false, radio: false, choice: 'a', count: 1 }"></state></defs>` +
            `<form>` +
            `<input class="text" bind:value="form.text">` +
            `<input class="check" type="checkbox" bind:checked="form.checked">` +
            `<input class="radio" type="radio" bind:checked="form.radio">` +
            `<select class="choice" bind:value="form.choice"><option value="a">A</option><option value="b">B</option></select>` +
            `<input class="number" type="number" bind:value="form.count">` +
            `<output class="result" $value="[form.text, form.checked, form.radio, form.choice, form.count]"></output>` +
            `</form></template><x-form id="f"></x-form>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#f');
          const text = root.querySelector('.text');
          const check = root.querySelector('.check');
          const radio = root.querySelector('.radio');
          const choice = root.querySelector('.choice');
          const number = root.querySelector('.number');
          text.value = 'next'; text.dispatchEvent(new Event('input', { bubbles: true }));
          check.checked = true; check.dispatchEvent(new Event('change', { bubbles: true }));
          radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
          choice.value = 'b'; choice.dispatchEvent(new Event('change', { bubbles: true }));
          number.value = '7'; number.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
          return root.querySelector('.result').textContent;
        })()`);
        assert.equal(result, "next true true b 7");
      } finally {
        await browser.close();
      }
    });

    it(`${name} reactively updates structural ranges and preserves keyed node identity`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-structure" status="early" summary="Structure.">` +
            `<defs>` +
            `<state name="show" :value="true"></state>` +
            `<state name="rows" :value="[{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }, { id: 4, label: 'D' }, { id: 5, label: 'E' }]"></state>` +
            `<state name="mode" :value="'a'"></state>` +
            `<state name="person" :value="{ name: 'Ada' }"></state>` +
            `<handler name="change">` +
            `<set name="show" :value="false"></set>` +
            `<set name="rows" :value="[{ id: 1, label: 'A' }, { id: 5, label: 'E' }, { id: 3, label: 'C2' }, { id: 4, label: 'D' }, { id: 2, label: 'B' }]"></set>` +
            `<set name="mode" :value="'b'"></set>` +
            `<set name="person" :value="{ name: 'Grace' }"></set>` +
            `</handler></defs>` +
            `<main><button on:click="change">change</button>` +
            `<i class="conditional" $if="show">shown</i>` +
            `<ul><li $each="row of rows" $key="row.id" :data-id="row.id" $value="row.label"></li></ul>` +
            `<div $match="mode as current"><span class="a" $when="current = 'a'">A</span><span class="b" $else>B</span></div>` +
            `<p $with="person as current" class="person" $value="current.name"></p>` +
            `</main></template><x-structure id="s"></x-structure>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#s');
          const before = Array.from(root.querySelectorAll('li'));
          const list = root.querySelector('ul');
          const nativeMoveBefore = typeof list.moveBefore === 'function';
          let moveBeforeCalls = 0;
          if (nativeMoveBefore) {
            const moveBefore = list.moveBefore;
            Object.defineProperty(list, 'moveBefore', { value(node, child) {
              moveBeforeCalls += 1;
              return moveBefore.call(this, node, child);
            }});
          }
          let movedRows = 0;
          const observer = new MutationObserver(records => {
            for (const record of records) {
              movedRows += Array.from(record.addedNodes).filter(node => node instanceof HTMLLIElement).length;
            }
          });
          observer.observe(list, { childList: true });
          root.querySelector('button').click();
          await Promise.resolve();
          await Promise.resolve();
          for (const record of observer.takeRecords()) {
            movedRows += Array.from(record.addedNodes).filter(node => node instanceof HTMLLIElement).length;
          }
          observer.disconnect();
          const after = Array.from(root.querySelectorAll('li'));
          return {
            conditional: root.querySelector('.conditional') !== null,
            rows: after.map((row) => [row.dataset.id, row.textContent]),
            identitiesPreserved: after.every((row) => before.includes(row)),
            arm: root.querySelector('.b')?.textContent,
            oldArmGone: root.querySelector('.a') === null,
            person: root.querySelector('.person')?.textContent,
            movedRows,
            nativeMoveBefore,
            moveBeforeCalls,
          };
        })()`);
        const { nativeMoveBefore, moveBeforeCalls, ...behavior } = result as {
          readonly nativeMoveBefore: boolean;
          readonly moveBeforeCalls: number;
        } & Readonly<Record<string, unknown>>;
        assert.deepEqual(behavior, {
          conditional: false,
          rows: [["1", "A"], ["5", "E"], ["3", "C2"], ["4", "D"], ["2", "B"]],
          identitiesPreserved: true,
          arm: "B",
          oldArmGone: true,
          person: "Grace",
          movedRows: 2,
        });
        assert.equal(moveBeforeCalls > 0, nativeMoveBefore);
      } finally {
        await browser.close();
      }
    });

    it(`${name} leaves ordered keyed blocks settled across insertion and deletion`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-key-order" status="early" summary="Key order.">` +
            `<defs><state name="rows" :value="[{ id: 1 }, { id: 2 }, { id: 3 }]"></state></defs>` +
            `<ul><li $each="row of rows" $key="row.id" :data-id="row.id" $value="row.id"></li></ul>` +
            `</template><x-key-order id="keys"></x-key-order>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#keys');
          const list = root;
          const host = window.HtmlRuntime.getComponentHost(root);
          const identities = new Map(Array.from(list.querySelectorAll('li'), row => [row.dataset.id, row]));
          const update = async rows => {
            const existing = new Set(list.querySelectorAll('li'));
            let moved = 0;
            const observer = new MutationObserver(records => {
              for (const record of records) {
                moved += Array.from(record.addedNodes).filter(node => existing.has(node)).length;
              }
            });
            observer.observe(list, { childList: true });
            host.state.rows = rows;
            await Promise.resolve();
            await Promise.resolve();
            for (const record of observer.takeRecords()) {
              moved += Array.from(record.addedNodes).filter(node => existing.has(node)).length;
            }
            observer.disconnect();
            return moved;
          };
          const insertionMoves = await update([{ id: 1 }, { id: 4 }, { id: 2 }, { id: 3 }]);
          const deletionMoves = await update([{ id: 1 }, { id: 4 }, { id: 3 }]);
          const rows = Array.from(list.querySelectorAll('li'));
          return {
            insertionMoves,
            deletionMoves,
            order: rows.map(row => row.dataset.id),
            retained: rows[0] === identities.get('1') && rows[2] === identities.get('3'),
          };
        })()`);
        assert.deepEqual(result, {
          insertionMoves: 0,
          deletionMoves: 0,
          order: ["1", "4", "3"],
          retained: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} runs declared data reads and updates their reactive state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://api.example/**", async (route) => {
          const query = new URL(route.request().url()).searchParams.get("q");
          await route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ label: `Result ${query}` }),
          });
        });
        await page.setContent(
          `<template component="x-data" status="early" summary="Data.">` +
            `<defs><state name="query" :value="'hello'"></state>` +
            `<data name="result" src="https://api.example/search" type="json">` +
            `<param name="q" :value="query"></param></data></defs>` +
            `<main><i class="pending" $value="result.pending"></i>` +
            `<output class="label" $value="result.value.label"></output></main>` +
            `</template><x-data id="data"></x-data>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
        });
        await page.waitForFunction(() => document.querySelector("#data .label")?.textContent === "Result hello");
        const result = await page.evaluate(() => ({
          pending: document.querySelector("#data .pending")?.textContent,
          label: document.querySelector("#data .label")?.textContent,
        }));
        assert.deepEqual(result, { pending: "false", label: "Result hello" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps component controls associated with their author-owned form`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-slug" status="early" summary="Slug editor.">` +
            `<defs><state name="slug" :value="''"></state></defs>` +
            `<fieldset><input name="slug" required pattern="[a-z-]+" bind:value="slug">` +
            `<output $value="slug"></output></fieldset></template>` +
            `<form id="post" action="/posts" method="post"><x-slug></x-slug>` +
            `<button type="submit">Save post</button></form>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
          const input = document.querySelector("input[name=slug]") as HTMLInputElement;
          input.value = "short-slug";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelector("output")?.textContent === "short-slug");
        const result = await page.evaluate(() => {
          const input = document.querySelector("input[name=slug]") as HTMLInputElement;
          return {
            form: input.form?.id,
            valid: input.checkValidity(),
            output: document.querySelector("output")?.textContent,
            formCount: document.querySelectorAll("form").length,
          };
        });
        assert.deepEqual(result, { form: "post", valid: true, output: "short-slug", formCount: 1 });
      } finally {
        await browser.close();
      }
    });

    it(`${name} scopes component styles by authored provenance`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<style>.projected { background-color: rgb(240, 240, 0); }</style>` +
          `<template component="x-inner" status="early" summary="Inner component.">` +
            `<section class="inner"><div class="inside"><div class="own"><span class="marker"></span></div><slot></slot></div></section>` +
            `<style>:scope { border-top: 3px solid rgb(1, 2, 3); } .inside { background-color: rgb(0, 120, 0); } .projected, .deep { background-color: rgb(0, 0, 200); } @media all { .inside:has(.own > .marker) { padding-top: 9px; } }</style>` +
          `</template>` +
          `<template component="x-outer" status="early" summary="Outer component.">` +
            `<article><div class="own" required><span class="marker"></span><i class="leaf"></i></div><x-inner class="nested"><em class="projected"><b class="deep">Projected</b></em></x-inner></article>` +
            `<style>:scope { color: rgb(12, 34, 56); --inherited-token: inherited; } .own { --bare: yes; } article .leaf { --descendant: yes; } article > .own { --child: yes; } .own + x-inner { margin-left: 13px; } :scope:has(.own > .marker) { padding-left: 11px; } .inside { background-color: rgb(200, 0, 0); } @media all { .own:invalid { border-left: 7px solid rgb(90, 0, 0); } }</style>` +
          `</template>` +
          `<template component="x-base" status="early" summary="Base component.">` +
            `<button><slot></slot></button><style id="base-style">:scope { border-right: 4px solid rgb(1, 2, 3); }</style>` +
          `</template>` +
          `<template component="x-primary" status="early" summary="Delegated component.">` +
            `<x-base><slot></slot></x-base><style id="primary-style">:scope { padding-right: 6px; }</style>` +
          `</template>` +
          `<x-outer id="outer"></x-outer><x-primary id="delegated">Label</x-primary>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { observeDocument(): () => void } })
            .HtmlRuntime.observeDocument();
        });
        await page.waitForFunction(() => document.querySelector("#outer > section.inner") !== null);
        await page.waitForFunction(() => document.querySelector("#delegated")?.localName === "button");

        const result = await page.evaluate(`(() => {
          const outer = document.querySelector("#outer");
          const own = outer.querySelector(":scope > .own");
          const leaf = own.querySelector(".leaf");
          const nested = outer.querySelector(":scope > section.inner");
          const inside = nested.querySelector(".inside");
          const projected = inside.querySelector(".projected");
          const deep = projected.querySelector(".deep");
          const delegated = document.querySelector("#delegated");
          const value = (element, property) =>
            getComputedStyle(element).getPropertyValue(property).trim();
          return {
            outer: {
              padding: value(outer, "padding-left"),
              color: value(outer, "color"),
              provenance: outer.getAttribute("data-component"),
              roots: outer.getAttribute("data-component-root"),
            },
            own: {
              bare: value(own, "--bare"),
              child: value(own, "--child"),
              invalidBorder: value(own, "border-left-width"),
            },
            leaf: value(leaf, "--descendant"),
            nested: {
              margin: value(nested, "margin-left"),
              border: value(nested, "border-top-width"),
              provenance: nested.getAttribute("data-component"),
              roots: nested.getAttribute("data-component-root"),
            },
            inside: {
              background: value(inside, "background-color"),
              padding: value(inside, "padding-top"),
              color: value(inside, "color"),
            },
            projected: {
              background: value(projected, "background-color"),
              marker: projected.hasAttribute("data-slotted"),
              color: value(projected, "color"),
            },
            deepBackground: value(deep, "background-color"),
            delegated: {
              element: delegated.localName,
              border: value(delegated, "border-right-width"),
              padding: value(delegated, "padding-right"),
              provenance: delegated.getAttribute("data-component"),
              roots: delegated.getAttribute("data-component-root"),
              baseStyles: document.querySelectorAll("#base-style").length,
              primaryStyles: document.querySelectorAll("#primary-style").length,
            },
          };
        })()`);

        assert.deepEqual(result, {
          outer: {
            padding: "11px",
            color: "rgb(12, 34, 56)",
            provenance: "x-outer",
            roots: "x-outer",
          },
          own: { bare: "yes", child: "yes", invalidBorder: "0px" },
          leaf: "yes",
          nested: {
            margin: "13px",
            border: "3px",
            provenance: "x-outer x-inner",
            roots: "x-inner",
          },
          inside: {
            background: "rgb(0, 120, 0)",
            padding: "9px",
            color: "rgb(12, 34, 56)",
          },
          projected: {
            background: "rgb(240, 240, 0)",
            marker: true,
            color: "rgb(12, 34, 56)",
          },
          deepBackground: "rgba(0, 0, 0, 0)",
          delegated: {
            element: "button",
            border: "4px",
            padding: "6px",
            provenance: "x-primary x-base",
            roots: "x-primary x-base",
            baseStyles: 1,
            primaryStyles: 1,
          },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} projects named, fallback, and data-selected slots and reconciles public props`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-panel" status="early" summary="Panel.">` +
            `<defs><prop name="rows" type="list(object({ id: string }))">Rows.</prop><prop name="label" type="string" default="Panel">Label.</prop></defs>` +
            `<section as="section | article"><header><slot name="title"><h2 class="title-fallback">Untitled</h2></slot></header>` +
            `<output class="label" $value="label"></output><main><slot><p class="body-fallback">Empty</p></slot></main>` +
            `<ul><li $each="row of rows" $key="row.id"><slot :name="format('row-%s', row.id)"><span class="row-fallback" $value="row.id"></span></slot></li></ul></section>` +
          `</template>` +
          `<x-panel id="filled" as="article" label="Initial"><h1 id="title-node" slot="title">Title</h1><p id="body-node">Body</p><strong id="row-node" slot="row-a">A</strong></x-panel>` +
          `<x-panel id="empty"></x-panel>`,
        );
        await page.evaluate(() => {
          const filled = document.querySelector("#filled") as Element & { rows?: unknown };
          const empty = document.querySelector("#empty") as Element & { rows?: unknown };
          filled.rows = [{ id: "a" }, { id: "b" }];
          empty.rows = [];
        });
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(async () => {
          const title = document.querySelector('#title-node');
          const body = document.querySelector('#body-node');
          const row = document.querySelector('#row-node');
          window.HtmlRuntime.lowerDocument();
          const filled = document.querySelector('#filled');
          const empty = document.querySelector('#empty');
          const initial = {
            root: filled.localName,
            label: filled.querySelector('.label').textContent,
            titleSame: filled.querySelector('#title-node') === title,
            bodySame: filled.querySelector('#body-node') === body,
            rowSame: filled.querySelector('#row-node') === row,
            projected: [title, body, row].map(node => node.hasAttribute('data-slotted')),
            rows: Array.from(filled.querySelectorAll('li'), item => item.textContent),
            fallbacks: [
              empty.querySelector('.title-fallback')?.textContent,
              empty.querySelector('.body-fallback')?.textContent,
            ],
          };
          filled.label = 'Updated';
          filled.rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
          await Promise.resolve();
          filled.setAttribute('data-label', 'External');
          await Promise.resolve();
          await Promise.resolve();
          return {
            initial,
            updated: {
              label: filled.querySelector('.label').textContent,
              rows: Array.from(filled.querySelectorAll('li'), item => item.textContent),
              reflectedLabel: filled.getAttribute('data-label'),
              reflectedRows: filled.getAttribute('data-rows'),
            },
          };
        })()`);

        assert.deepEqual(result, {
          initial: {
            root: "article",
            label: "Initial",
            titleSame: true,
            bodySame: true,
            rowSame: true,
            projected: [true, true, true],
            rows: ["A", "b"],
            fallbacks: ["Untitled", "Empty"],
          },
          updated: {
              label: "External",
            rows: ["A", "b", "c"],
              reflectedLabel: "External",
            reflectedRows: '[{"id":"a"},{"id":"b"},{"id":"c"}]',
          },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} maps camel-case public props to kebab-case HTML attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-camel" status="early" summary="Camel-case props.">` +
            `<defs><prop name="defaultValue" type="string" default="fallback">Default value.</prop></defs>` +
            `<output :data-default="defaultValue"></output></template>` +
          `<x-camel id="camel" default-value="authored"></x-camel>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          const root = document.getElementById("camel") as Element & { defaultValue?: string };
          return {
            value: root.defaultValue,
            rendered: root.getAttribute("data-default"),
            reflected: root.getAttribute("data-default-value"),
            legacyReflection: root.hasAttribute("data-defaultvalue"),
          };
        });
        assert.deepEqual(result, {
          value: "authored",
          rendered: "authored",
          reflected: "authored",
          legacyReflection: false,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves nested projected invocations independent of definition order`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-nested-child" status="early" summary="Child."><button><slot></slot></button></template>` +
          `<template component="x-nested-parent" status="early" summary="Parent."><section><slot></slot></section></template>` +
          `<x-nested-parent id="parent"><x-nested-child id="child"><span id="label">Label</span></x-nested-child></x-nested-parent>`,
        );
        const label = await page.$("#label");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          return {
            parent: document.getElementById("parent")?.localName,
            child: document.getElementById("child")?.localName,
            text: document.getElementById("child")?.textContent,
          };
        });
        assert.deepEqual(result, { parent: "section", child: "button", text: "Label" });
        assert.equal(await label?.evaluate((node) => node === document.getElementById("label")), true);
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a prop value when a component event has the same name`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-openable" status="early" summary="Openable.">` +
            `<defs><prop name="open" type="boolean?">Open state.</prop><event name="open" type="boolean"></event></defs>` +
            `<section :data-open="open"></section></template><x-openable id="openable" open></x-openable>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          const root = document.getElementById("openable") as Element & { open?: boolean };
          return { value: root.open, attribute: root.getAttribute("data-open") };
        });
        assert.deepEqual(result, { value: true, attribute: "true" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} adopts compatible server DOM, repairs owned markup, and preserves live controls`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-hydrated" status="early" summary="Hydration.">` +
            `<defs><prop name="label" type="string" default="Default">Label.</prop></defs>` +
            `<article><h2 $value="label"></h2><input .value="label"><slot></slot></article></template>` +
          `<article id="server" data-component="x-hydrated" data-component-root="x-hydrated" data-label="Server">` +
            `<h3 data-component="x-hydrated">stale</h3>` +
            `<input data-component="x-hydrated" value="server"><em id="projected" data-slotted>Projected</em>` +
          `</article>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const root = document.querySelector('#server');
          const input = root.querySelector('input');
          const projected = root.querySelector('#projected');
          input.value = 'user edit';
          input.focus();
          input.setSelectionRange(2, 6);
          const lowered = window.HtmlRuntime.lowerDocument();
          const initial = {
            lowered,
            rootSame: document.querySelector('#server') === root,
            inputSame: root.querySelector('input') === input,
            projectedSame: root.querySelector('#projected') === projected,
            heading: root.querySelector('h2')?.textContent,
            staleGone: root.querySelector('h3') === null,
            value: input.value,
            focused: document.activeElement === input,
            selection: [input.selectionStart, input.selectionEnd],
          };
          root.label = 'Next';
          await Promise.resolve();
          return { initial, updated: { heading: root.querySelector('h2').textContent, value: input.value } };
        })()`);
        assert.deepEqual(result, {
          initial: {
            lowered: 1,
            rootSame: true,
            inputSame: true,
            projectedSame: true,
            heading: "Server",
            staleGone: true,
            value: "user edit",
            focused: true,
            selection: [2, 6],
          },
          updated: { heading: "Next", value: "Next" },
        });

        const unsafe = await browser.newPage();
        await unsafe.setContent(
          `<template component="x-safe-root" status="early" summary="Safe root."><article>Expected</article></template>` +
          `<section id="unsafe" data-component="x-safe-root" data-component-root="x-safe-root">Untouched</section>`,
        );
        await unsafe.addScriptTag({ path: bundlePath });
        const rejected = await unsafe.evaluate(`(() => {
          const root = document.querySelector('#unsafe');
          try { window.HtmlRuntime.lowerDocument(); }
          catch (error) { return { code: error.diagnostic.code, same: document.querySelector('#unsafe') === root, text: root.textContent }; }
          return { code: 'none', same: false, text: '' };
        })()`);
        assert.deepEqual(rejected, { code: "HR005", same: true, text: "Untouched" });
        await unsafe.close();
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders native-scope and fallback CSS equivalently`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const rules = [
          "div { color: rgb(21, 43, 65); }",
          ".own { --bare: yes; }",
          "div > .own { --child: yes; }",
          "div .leaf { --descendant: yes; }",
          ".own + x-child { margin-left: 13px; }",
          "div:has(.own > .leaf:invalid) { padding-left: 11px; }",
          "@media all { .leaf:invalid { border-left: 7px solid rgb(90, 0, 0); } }",
          ".inside, .projected { background-color: rgb(200, 0, 0); }",
        ].join("\n");
        const nativeCss = transformComponentStyles(rules, "x-native", {
          mode: "scope",
          rootElement: "div",
        });
        const fallbackCss = transformComponentStyles(rules, "x-fallback", {
          mode: "attribute",
          rootElement: "div",
        });
        const tree = (owner: string): string =>
          `<div class="card" data-component="${owner}" data-component-root="${owner}">` +
            `<p class="own" data-component="${owner}"><i class="leaf" data-invalid data-component="${owner}"></i></p>` +
            `<section data-component="${owner} x-child" data-component-root="x-child">` +
              `<span class="inside" data-component="x-child"></span>` +
              `<em class="projected" data-slotted><b class="deep"></b></em>` +
            `</section>` +
          `</div>`;
        await page.setContent(
          `<style>${nativeCss}\n${fallbackCss}</style>` + tree("x-native") + tree("x-fallback"),
        );

        const result = await page.evaluate(`(() => {
          const snapshot = (owner) => {
            const root = document.querySelector('[data-component-root="' + owner + '"]');
            const own = root.querySelector('.own');
            const leaf = root.querySelector('.leaf');
            const nested = root.querySelector('[data-component-root="x-child"]');
            const inside = root.querySelector('.inside');
            const projected = root.querySelector('.projected');
            const value = (element, property) => getComputedStyle(element).getPropertyValue(property).trim();
            return {
              root: [value(root, 'color'), value(root, 'padding-left')],
              own: [value(own, '--bare'), value(own, '--child')],
              leaf: [value(leaf, '--descendant'), value(leaf, 'border-left-width')],
              nested: value(nested, 'margin-left'),
              inside: [value(inside, 'background-color'), value(inside, 'color')],
              projected: [value(projected, 'background-color'), value(projected, 'color')],
            };
          };
          return { supported: 'CSSScopeRule' in window, native: snapshot('x-native'), fallback: snapshot('x-fallback') };
        })()`) as { supported: boolean; native: unknown; fallback: unknown };

        assert.equal(result.supported, true);
        assert.deepEqual(result.native, result.fallback);
        assert.deepEqual(result.native, {
          root: ["rgb(21, 43, 65)", "0px"],
          own: ["yes", "yes"],
          leaf: ["yes", "0px"],
          nested: "13px",
          inside: ["rgba(0, 0, 0, 0)", "rgb(21, 43, 65)"],
          projected: ["rgba(0, 0, 0, 0)", "rgb(21, 43, 65)"],
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers definitions to equivalent native DOM`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(source);
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(() => {
          const keptChild = document.querySelector("#kept-child");
          const lowered = window.HtmlRuntime.lowerDocument();

          function snapshot(element) {
            return {
              namespace: element.namespaceURI,
              tag: element.localName,
              attributes: Array.from(element.attributes)
                .map((attribute) => [attribute.name, attribute.value])
                .sort(([left], [right]) => left.localeCompare(right)),
              children: Array.from(element.childNodes).map((child) =>
                child.nodeType === Node.TEXT_NODE
                  ? { text: child.textContent }
                  : snapshot(child),
              ),
            };
          }

          const primary = document.querySelector("main > #primary");
          const disabled = document.querySelector("main > #disabled");
          const status = document.querySelector("main > #status");
          if (!(primary instanceof HTMLButtonElement)) throw new Error("Primary button was not lowered.");
          if (!(disabled instanceof HTMLButtonElement)) throw new Error("Disabled button was not lowered.");
          if (!(status instanceof HTMLOutputElement)) throw new Error("Status output was not lowered.");

          return {
            lowered,
            primary: snapshot(primary),
            disabled: snapshot(disabled),
            status: snapshot(status),
            primaryDisabled: primary.disabled,
            disabledDisabled: disabled.disabled,
            statusTextContent: status.textContent,
            childIdentityPreserved: primary.querySelector("#kept-child") === keptChild,
            definitionsRemaining: document.querySelectorAll("template[component]").length,
            invocationHostsRemaining: document.querySelectorAll("x-button, x-status").length,
            customElementRegistered: customElements.get("x-button") !== undefined,
          };
        })()`);

        assert.deepEqual(result, {
          lowered: 3,
          primary: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "button",
            attributes: [
              ["aria-label", "Save changes"],
              ["class", "cta"],
              ["data-component", "x-button"],
              ["data-component-root", "x-button"],
              ["data-disabled", "false"],
              ["data-size", "lg"],
              ["data-trace", "runtime"],
              ["data-variant", "outline"],
              ["data-x-button", ""],
              ["id", "primary"],
              ["type", "button"],
            ],
            children: [
              { text: "Save " },
              {
                namespace: "http://www.w3.org/1999/xhtml",
                tag: "strong",
                attributes: [["data-slotted", ""], ["id", "kept-child"]],
                children: [{ text: "now" }],
              },
            ],
          },
          disabled: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "button",
            attributes: [
              ["data-component", "x-button"],
              ["data-component-root", "x-button"],
              ["data-disabled", "true"],
              ["data-size", "md"],
              ["data-variant", "solid"],
              ["data-x-button", ""],
              ["disabled", ""],
              ["id", "disabled"],
              ["type", "button"],
            ],
            children: [],
          },
          status: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "output",
            attributes: [
              ["data-component", "x-status"],
              ["data-component-root", "x-status"],
              ["data-message", "Ready"],
              ["id", "status"],
            ],
            children: [{ text: "Ready" }],
          },
          primaryDisabled: false,
          disabledDisabled: true,
          statusTextContent: "Ready",
          childIdentityPreserved: true,
          definitionsRemaining: 0,
          invocationHostsRemaining: 0,
          customElementRegistered: false,
        });
      } finally {
        await browser.close();
      }
    });
  }
});
