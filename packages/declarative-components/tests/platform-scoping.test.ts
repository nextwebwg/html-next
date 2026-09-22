/**
 * Platform assumptions behind the proposal's style scoping (nextwebwg.org/html-next/styling) and
 * rendered-form carrier (nextwebwg.org/html-next/rendered-form), checked in every engine:
 *
 * - native `@scope` matches a component's region, excludes nested components and projected
 *   content, and lets a condition before `:scope` reach outside while the subject stays inside;
 * - the browser can parse a component style block once three pseudo-classes are renamed into valid
 *   selectors, and the Object Model can route and rewrite the rules, so no CSS parser is needed;
 * - a `<?carrier?>` mark survives parsing and serialization as a processing instruction or as the
 *   comment an engine produces instead.
 *
 * The compile step below is the design under test, written inline; the runtime's implementation
 * must keep these results.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const engines: readonly [string, BrowserType][] = [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]];

async function inEachEngine(html: string, check: (page: Page, engine: string) => Promise<void>): Promise<void> {
  for (const [name, type] of engines) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await check(page, name);
    } finally {
      await browser.close();
    }
  }
}

describe.skipIf(!enabled)("platform assumptions for style scoping", () => {
  it("scopes a region with native @scope and lets conditions before :scope reach outside", async () => {
    await inEachEngine(`<!doctype html>
      <style>
        @scope ([data-component~="x-card"]) to ([data-component], [data-slotted]) {
          :scope { outline: 1px solid; }
          .own { color: rgb(1, 1, 1); }
          .dark :scope .context { color: rgb(2, 2, 2); }
          .dark .relative { color: rgb(3, 3, 3); }
          :is(x-page, :where([data-component~="x-page"])) :scope .by-tag { color: rgb(4, 4, 4); }
          :scope ~ .sibling { color: rgb(5, 5, 5); }
          .projected, .nested { color: rgb(6, 6, 6); }
        }
      </style>
      <div class="dark"><main data-component="x-page">
        <article data-component="x-card">
          <span class="own">own</span><span class="context">context</span>
          <span class="relative">relative</span><span class="by-tag">by tag</span>
          <span data-slotted class="projected">projected</span>
          <section data-component="x-inner"><span class="nested">nested</span></section>
        </article>
        <p class="sibling">sibling</p>
      </main></div>`, async (page, engine) => {
      const color = await page.evaluate(() => Object.fromEntries(
        ["own", "context", "relative", "by-tag", "sibling", "projected", "nested"].map((name) =>
          [name, getComputedStyle(document.querySelector(`.${name}`)!).color]),
      ));
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("article")!).outlineStyle), "solid", `${engine}: root`);
      assert.equal(color.own, "rgb(1, 1, 1)", `${engine}: own markup`);
      assert.equal(color.context, "rgb(2, 2, 2)", `${engine}: ancestor before :scope`);
      assert.notEqual(color.relative, "rgb(3, 3, 3)", `${engine}: a selector without :scope is relative to the component`);
      assert.equal(color["by-tag"], "rgb(4, 4, 4)", `${engine}: component ancestor by tag`);
      assert.notEqual(color.sibling, "rgb(5, 5, 5)", `${engine}: subject outside the region`);
      assert.notEqual(color.projected, "rgb(6, 6, 6)", `${engine}: projected content`);
      assert.notEqual(color.nested, "rgb(6, 6, 6)", `${engine}: nested component`);
    });
  });

  it("compiles :host, :host-state(), and deep :slotted() by renaming, parsing, and routing rules", async () => {
    await inEachEngine(`<!doctype html>
      <article data-component="x-prose" data-x-prose-state="size=sm">
        <p class="label" id="own">own</p>
        <div data-slotted><h2 id="h2">heading</h2><ul><li id="li">item</li></ul><span class="label" id="consumer">x</span></div>
        <section data-component="x-inner"><h2 id="inner">nested</h2></section>
      </article>`, async (page, engine) => {
      const result = await page.evaluate(() => {
        const tag = "x-prose";
        const source = `
          :host { outline: 1px solid }
          .label { color: rgb(1, 1, 1); }
          :host-state([size="sm"]) .label { font-size: 8px }
          :slotted(h2) { color: rgb(2, 2, 2); & + ul { margin-top: 7px } }
          :slotted(ul li) { color: rgb(3, 3, 3) }
          @media (width > 1px) { :slotted(h2) { letter-spacing: 2px } }
          a[title="} :slotted(x) {"] { color: rgb(9, 9, 9) } /* :slotted(y) { } */`;
        const sentinel: Record<string, string> = { slotted: "[--slotted]", "host-state": "[--state]" };
        const renamed = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|:(slotted|host-state)\(/g,
          (match, kind?: string) => kind === undefined ? match : `:where(${sentinel[kind]}):is(`);
        const parsed = new CSSStyleSheet();
        parsed.replaceSync(renamed);
        const root = `[data-component~="${tag}"]`;
        const stateTest = (tests: string) => tests.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_m, name: string, value?: string) =>
          `[data-${tag}-state~="${value === undefined ? name : `${name}=${encodeURIComponent(value)}`}"]`);
        const groups: Record<"own" | "slotted", string[]> = { own: [], slotted: [] };
        const route = (rules: CSSRuleList, wrap: (css: string) => string = (css) => css): void => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule) {
              const kind = rule.selectorText.includes("[--slotted]") ? "slotted" : "own";
              rule.selectorText = rule.selectorText
                .replace(/:where\(\[--state\]\):is\(((?:\[[^\]]*\])+)\)/g, (_m, tests: string) => `:host${stateTest(tests)}`)
                .replace(/:where\(\[--slotted\]\):is\(/g, ":where([data-slotted], [data-slotted] *):is(")
                .replace(/:host\b/g, kind === "own" ? ":scope" : root);
              groups[kind].push(wrap(rule.cssText));
            } else if ("cssRules" in rule) {
              const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{"));
              route((rule as CSSGroupingRule).cssRules, (css) => wrap(`${prelude}{ ${css} }`));
            }
          }
        };
        route(parsed.cssRules);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync([
          `@scope (${root}) to ([data-component], [data-slotted]) { ${groups.own.join("\n")} }`,
          `@scope (${root}) to ([data-component]) { ${groups.slotted.join("\n")} }`,
        ].join("\n"));
        document.adoptedStyleSheets = [sheet];
        const style = (id: string) => getComputedStyle(document.getElementById(id)!);
        return {
          root: getComputedStyle(document.querySelector("article")!).outlineStyle,
          own: style("own").color,
          state: style("own").fontSize,
          deep: style("h2").color,
          nested: getComputedStyle(document.querySelector("ul")!).marginTop,
          complex: style("li").color,
          media: style("h2").letterSpacing,
          consumer: style("consumer").color,
          inner: style("inner").color,
          stringKept: groups.own.some((css) => css.includes("} :slotted(x) {")),
        };
      });
      assert.equal(result.root, "solid", `${engine}: :host`);
      assert.equal(result.own, "rgb(1, 1, 1)", `${engine}: own rule`);
      assert.equal(result.state, "8px", `${engine}: :host-state()`);
      assert.equal(result.deep, "rgb(2, 2, 2)", `${engine}: deep :slotted()`);
      assert.equal(result.nested, "7px", `${engine}: nested rule inside :slotted()`);
      assert.equal(result.complex, "rgb(3, 3, 3)", `${engine}: complex :slotted() argument`);
      assert.equal(result.media, "2px", `${engine}: grouping rule kept`);
      assert.notEqual(result.consumer, "rgb(1, 1, 1)", `${engine}: consumer content unmatched`);
      assert.notEqual(result.inner, "rgb(2, 2, 2)", `${engine}: nested component unmatched`);
      assert.equal(result.stringKept, true, `${engine}: renamed tokens inside strings and comments untouched`);
    });
  });
});

describe.skipIf(!enabled)("platform assumptions for the rendered-form carrier", () => {
  it("reads a <?carrier?> mark as a processing instruction or the comment the engine produces", async () => {
    await inEachEngine(`<!doctype html><div id="ssr"><article data-component="x-card"><p>own</p><?carrier?><template><b slot="title">Hidden</b>Body</template></article></div>`, async (page, engine) => {
      const result = await page.evaluate(() => {
        const isMark = (node: Node | null) => node?.nodeType === Node.PROCESSING_INSTRUCTION_NODE
          ? (node as ProcessingInstruction).target === "carrier"
          : node?.nodeType === Node.COMMENT_NODE && /^\?carrier(?:\s|\?|$)/.test((node as Comment).data);
        const carrier = (root: Element) => Array.from(root.children).find((child) =>
          child.localName === "template" && isMark(child.previousSibling)) as HTMLTemplateElement | undefined;
        const parsed = document.querySelector("#ssr article")!;
        const again = document.createElement("div");
        again.innerHTML = parsed.outerHTML;
        const decoy = document.createElement("div");
        decoy.innerHTML = '<article data-component="x-card"><template><i>own template</i></template></article>';
        return {
          found: carrier(parsed)?.content.querySelector('[slot="title"]')?.textContent ?? null,
          afterRoundTrip: carrier(again.firstElementChild!)?.content.querySelector('[slot="title"]')?.textContent ?? null,
          unmarkedIgnored: carrier(decoy.firstElementChild!) === undefined,
        };
      });
      assert.equal(result.found, "Hidden", `${engine}: carrier found after parsing`);
      assert.equal(result.afterRoundTrip, "Hidden", `${engine}: carrier found after serialization`);
      assert.equal(result.unmarkedIgnored, true, `${engine}: an unmarked template is not the carrier`);
    });
  });
});
