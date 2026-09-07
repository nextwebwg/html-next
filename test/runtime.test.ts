import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

const enabled = process.env.HTML7_BROWSER_TEST === "1";
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

    temporaryDirectory = await mkdtemp(join(tmpdir(), "html7-runtime-"));
    bundlePath = join(temporaryDirectory, "runtime.js");
    await build({
      entryPoints: [runtimeUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "Html7Runtime",
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
    it(`${name} lowers definitions to equivalent native DOM`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(source);
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(() => {
          const keptChild = document.querySelector("#kept-child");
          const lowered = window.Html7Runtime.lowerDocument();

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
            definitionsRemaining: document.querySelectorAll("html7-component").length,
            invocationHostsRemaining: document.querySelectorAll("looma-button, looma-status").length,
            customElementRegistered: customElements.get("looma-button") !== undefined,
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
              ["data-lm-size", "lg"],
              ["data-lm-variant", "outline"],
              ["data-looma", ""],
              ["data-trace", "runtime"],
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
              ["data-lm-size", "md"],
              ["data-lm-variant", "solid"],
              ["data-looma", ""],
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
