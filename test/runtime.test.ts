import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./runtime.html", import.meta.url);
const runtimeUrl = new URL("../src/runtime.ts", import.meta.url);

describe("browser runtime", { skip: !enabled }, () => {
  let bundlePath = "";
  let temporaryDirectory = "";
  let source = "";

  before(async () => {
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

  after(async () => {
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

    it(`${name} seeds state/computed/data and consumes on:/bind:/handlers (L1 one-shot)`, async () => {
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
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#c");
          return {
            count: root.getAttribute("data-count"),
            doubled: root.getAttribute("data-doubled"),
            buttonText: root.querySelector("button").textContent,
            buttonHasOnClick: root.querySelector("button").hasAttribute("on:click"),
            boundValue: root.querySelector("output").getAttribute("value"),
            pending: root.querySelector("i").textContent,
            spanHasOnConnect: root.querySelector("span").hasAttribute("on:connect"),
          };
        })()`);
        assert.deepEqual(result, {
          count: "5", // state seeded from the start prop
          doubled: "10", // computed evaluated once over state
          buttonText: "5", // $value reads state
          buttonHasOnClick: false, // on: consumed, never emitted
          boundValue: "5", // bind: renders one-way at L1
          pending: "true", // data seeded in its pending shape
          spanHasOnConnect: false, // lifecycle consumed
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
                attributes: [["id", "kept-child"]],
                children: [{ text: "now" }],
              },
            ],
          },
          disabled: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "button",
            attributes: [
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
            attributes: [["id", "status"]],
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
