/**
 * The HTML Next in-browser conformance corpus.
 *
 * This is the shared `source -> expected observable result` test table for the in-browser
 * compilation path (`src/runtime.ts`, entry point `lowerDocument`), on the model of
 * web-platform-tests: every case is full HTML (component definition(s) + invocation(s)) plus a
 * declarative expectation, and every implementation of HTML Next must agree with it.
 *
 * Two case shapes:
 *  - Success: after `lowerDocument()`, a `probe` (a JS function body run in the page, with
 *    `snapshot`, `q`, `qa` helpers in scope) returns a JSON value that must `deepEqual` `result`.
 *  - Diagnostic: `lowerDocument()` must throw an `HtmlDiagnosticError` whose `.diagnostic.code`
 *    equals `code`.
 *
 * The harness in `tests/conformance.test.ts` runs the whole table against Chromium, Firefox, and
 * WebKit. See `tests/conformance/README.md` for how to run it.
 */

export interface SuccessExpect {
  readonly probe: string;
  readonly result: unknown;
  readonly after?: readonly { readonly action: string; readonly result: unknown }[];
}

export interface DiagnosticExpect {
  readonly code: string;
}

export interface ConformanceCase {
  readonly name: string;
  readonly source: string;
  readonly expect: SuccessExpect | DiagnosticExpect;
}

/** Wrap a component definition (defs/root/style) and its invocation(s) into a full source doc. */
function scene(parts: {
  tag?: string;
  defs?: string;
  root: string;
  style?: string;
  use?: string;
}): string {
  const tag = parts.tag ?? "x-t";
  const defs = parts.defs ? `<defs>${parts.defs}</defs>` : "";
  const style = parts.style ? `<style>${parts.style}</style>` : "";
  const use = parts.use ?? "";
  return (
    `<template component="${tag}" status="early" summary="Conformance test component.">` +
    defs +
    parts.root +
    style +
    `</template>` +
    use
  );
}

// ---------------------------------------------------------------------------
// Success cases: observable lowered DOM
// ---------------------------------------------------------------------------

const successes: ConformanceCase[] = [
  {
    name: "HTML parser recovery keeps the first duplicate attribute",
    source: scene({
      root: `<article class="first" class="second">Ready</article>`,
      use: `<x-t id="recovered"></x-t>`,
    }),
    expect: {
      probe: `const e = q('#recovered'); return { tag: e.localName, className: e.getAttribute('class'), text: e.textContent };`,
      result: { tag: "article", className: "first", text: "Ready" },
    },
  },
  {
    name: "preserves SVG namespaces and camelCase attributes inside a native root",
    source: scene({
      tag: "icon-close",
      defs: `<state name="box" value="0 0 24 24"></state>`,
      root: `<button type="button"><svg from:viewBox="$box" width="24" height="24" fill="none" stroke="currentColor">
        <path d="M6 6l12 12M18 6 6 18"></path><linearGradient id="g" from:gradientUnits="'userSpaceOnUse'"></linearGradient>
        <foreignObject width="10" height="10"><span>html</span></foreignObject></svg></button>`,
      use: `<icon-close id="icon"></icon-close>`,
    }),
    expect: {
      probe: `const svg = q('#icon svg'); return {
        root: q('#icon').localName,
        svgNamespace: svg.namespaceURI,
        viewBox: svg.getAttribute('viewBox'),
        pathNamespace: svg.querySelector('path').namespaceURI,
        gradientNamespace: svg.querySelector('linearGradient').namespaceURI,
        gradientUnits: svg.querySelector('linearGradient').getAttribute('gradientUnits'),
        foreignChildNamespace: svg.querySelector('foreignObject > span').namespaceURI,
      };`,
      result: {
        root: "button",
        svgNamespace: "http://www.w3.org/2000/svg",
        viewBox: "0 0 24 24",
        pathNamespace: "http://www.w3.org/2000/svg",
        gradientNamespace: "http://www.w3.org/2000/svg",
        gradientUnits: "userSpaceOnUse",
        foreignChildNamespace: "http://www.w3.org/1999/xhtml",
      },
    },
  },
  {
    name: "keeps a single native root when $with scopes the root",
    source: scene({
      tag: "x-root-with",
      defs: `<state name="label" value="Ada"></state><handler name="rename"><set name="label" expr:value="'Bea'"></set></handler>`,
      root: `<section $with="$label as display" from:data-label="$display"><strong $value="$display"></strong><button type="button" on:click="rename">Rename</button></section>`,
      use: `<x-root-with id="person"></x-root-with>`,
    }),
    expect: {
      probe: `return snapshot(q('#person'));`,
      result: {
        tag: "section",
        attributes: [
          ["data-component", "x-root-with"],
          ["data-label", "Ada"],
          ["id", "person"],
        ],
        children: [
          { tag: "strong", attributes: [], children: [{ text: "Ada" }] },
          { tag: "button", attributes: [["type", "button"]], children: [{ text: "Rename" }] },
        ],
      },
      after: [{
        action: `document.querySelector('#person button').click();`,
        result: {
          tag: "section",
          attributes: [
            ["data-component", "x-root-with"],
            ["data-label", "Bea"],
            ["id", "person"],
          ],
          children: [
            { tag: "strong", attributes: [], children: [{ text: "Bea" }] },
            { tag: "button", attributes: [["type", "button"]], children: [{ text: "Rename" }] },
          ],
        },
      }],
    },
  },
  {
    name: "lowers to native root with prop :attr, passthrough attrs, and default slot",
    source: scene({
      tag: "x-btn",
      defs: `<prop name="label" type="string" required>Label.</prop>`,
      root: `<button type="button" from:aria-label="$label"><slot></slot></button>`,
      use: `<x-btn id="b" class="cta" label="Save"><strong>now</strong></x-btn>`,
    }),
    expect: {
      probe: `return snapshot(q('#b'));`,
      result: {
        tag: "button",
        attributes: [
          ["aria-label", "Save"],
          ["class", "cta"],
          ["data-component", "x-btn"],
          ["data-label", "Save"],
          ["id", "b"],
          ["type", "button"],
        ],
        children: [{ tag: "strong", attributes: [["data-slotted", ""]], children: [{ text: "now" }] }],
      },
    },
  },
  {
    name: "lets invocation attributes win over template literals and combines class and style",
    source: scene({
      tag: "x-pre",
      defs: `<prop name="label" type="string" default="Bound">Label.</prop>`,
      root: `<button type="button" role="button" class="base" style="color: red" from:aria-label="$label"></button>`,
      use: `<x-pre id="p" type="submit" class="cta" style="margin: 0" aria-label="Ignored"></x-pre>`,
    }),
    expect: {
      probe: `const b = q('#p'); return [b.type, b.getAttribute('role'), b.className, b.style.color, b.style.margin, b.getAttribute('aria-label')];`,
      result: ["submit", "button", "base cta", "red", "0px", "Bound"],
    },
  },
  {
    name: "serializes booleans on enumerated attributes as true and false",
    source: scene({
      tag: "x-aria",
      defs: `<prop name="open" type="boolean" default="false">Open.</prop><prop name="gone" type="boolean" default="false">Gone.</prop><prop name="edit" type="boolean" default="false">Edit.</prop>`,
      root: `<button from:aria-expanded="$open" from:hidden="$gone" from:contenteditable="$edit"></button>`,
      use: `<x-aria id="closed"></x-aria><x-aria id="open" open gone edit></x-aria>`,
    }),
    expect: {
      probe: `return ["#closed", "#open"].map((id) => { const b = q(id); return [b.getAttribute("aria-expanded"), b.getAttribute("hidden"), b.getAttribute("contenteditable")]; });`,
      result: [["false", null, "false"], ["true", "", "true"]],
    },
  },
  {
    name: "styles by camel-case props and state with :host-state()",
    source: scene({
      tag: "x-camel-state",
      defs: `<prop name="isWide" type="boolean" default="true">Wide.</prop><state type="string" name="toneName" value="warm"></state>`,
      root: `<div></div>`,
      style: `:host([isWide]) { width: 123px; } :host-state([toneName="warm"]) { height: 45px; }`,
      use: `<x-camel-state id="c"></x-camel-state>`,
    }),
    expect: {
      probe: `const c = q('#c'); const style = getComputedStyle(c); return [c.getAttribute("data-x-camel-state-state"), style.width, style.height];`,
      result: ["isWide toneName toneName=warm", "123px", "45px"],
    },
  },
  {
    name: "matches :host in :slotted() rules as the component root",
    source: scene({
      tag: "x-rail",
      defs: `<prop name="wide" type="boolean" default="false">Wide.</prop>`,
      root: `<div><slot></slot></div>`,
      style: `:host > :slotted(*) { margin-left: 7px; } :host([wide]) > :slotted(p) { width: 55px; }`,
      use: `<x-rail wide><p id="child"><span id="grandchild">A</span></p></x-rail>`,
    }),
    expect: {
      probe: `const style = (id) => getComputedStyle(q('#' + id)); return [style("child").marginLeft, style("child").width, style("grandchild").marginLeft];`,
      result: ["7px", "55px", "0px"],
    },
  },
  {
    name: "applies a prop default when the invocation omits the prop",
    source: scene({
      defs: `<prop name="label" type="string" default="Hi">Label.</prop>`,
      root: `<button from:data-label="$label"></button>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: { probe: `return q('#b').getAttribute('data-label');`, result: "Hi" },
  },
  {
    name: "coerces number, boolean, enum, and string props",
    source: scene({
      defs:
        `<prop name="n" type="number" default="0">Number.</prop>` +
        `<prop name="flag" type="boolean" default="false">Boolean.</prop>` +
        `<prop name="kind" type="keyword" values="a, b" default="a">Enum.</prop>` +
        `<prop name="s" type="string" default="">String.</prop>`,
      root: `<div from:data-sum="$n + 1" from:data-flag="$flag" from:data-kind="$kind" from:data-s="$s"></div>`,
      use: `<x-t id="b" n="5" flag kind="b" s="hey"></x-t>`,
    }),
    expect: {
      probe:
        `const e = q('#b'); return { sum: e.getAttribute('data-sum'), ` +
        `hasFlag: e.hasAttribute('data-flag'), flag: e.getAttribute('data-flag'), ` +
        `kind: e.getAttribute('data-kind'), s: e.getAttribute('data-s') };`,
      result: { sum: "6", hasFlag: true, flag: "true", kind: "b", s: "hey" },
    },
  },
  {
    name: "attribute serialization: absent/false remove, true is present-empty, number stringifies, list space-joins",
    source: scene({
      defs:
        `<prop name="missing" type="string">Missing.</prop>` +
        `<prop name="flag" type="boolean" default="false">Boolean.</prop>`,
      root: `<div from:data-missing="$missing" from:data-off="$flag" from:data-on="not $flag" from:data-num="3" from:class="['a', 'b']"></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const e = q('#b'); return { hasMissing: e.hasAttribute('data-missing'), ` +
        `hasOff: e.hasAttribute('data-off'), on: e.getAttribute('data-on'), ` +
        `num: e.getAttribute('data-num'), cls: e.getAttribute('class') };`,
      result: { hasMissing: false, hasOff: false, on: "", num: "3", cls: "a b" },
    },
  },
  {
    name: "invocation attributes named after Object prototype members pass through",
    source: scene({
      root: `<button><slot></slot></button>`,
      use: `<x-t id="b" constructor="safe">Label</x-t>`,
    }),
    expect: {
      probe: `const e = q('#b'); return { value: e.getAttribute('constructor'), text: e.textContent };`,
      result: { value: "safe", text: "Label" },
    },
  },
  {
    name: "bind: renders its initial state; declared on: bindings are consumed",
    source: scene({
      defs:
        `<state name="v" value="x"></state>` +
        `<handler name="foo"></handler><handler name="c"></handler><handler name="d"></handler>`,
      root:
        `<div><output bind:value="v"></output>` +
        `<button on:click="foo" $value="$v"></button>` +
        `<span on:mouseover="c" on:mouseout="d"></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); const o = r.querySelector('output'), btn = r.querySelector('button'), sp = r.querySelector('span');` +
        `return { bound: o.getAttribute('value'), btnText: btn.textContent, ` +
        `btnHasOn: btn.hasAttribute('on:click'), spanHasMouseover: sp.hasAttribute('on:mouseover'), ` +
        `spanHasMouseout: sp.hasAttribute('on:mouseout') };`,
      result: {
        bound: "x",
        btnText: "x",
        btnHasOn: false,
        spanHasMouseover: false,
        spanHasMouseout: false,
      },
    },
  },
  {
    name: "$value renders escaped text (a <b> in data is literal characters)",
    source: scene({
      defs: `<prop name="body" type="string" default="">Body.</prop>`,
      root: `<p $value="$body"></p>`,
      use: `<x-t id="b" body="<b>hi</b>"></x-t>`,
    }),
    expect: {
      probe: `const e = q('#b'); return { hasBold: e.querySelector('b') !== null, text: e.textContent };`,
      result: { hasBold: false, text: "<b>hi</b>" },
    },
  },
  {
    name: "<template $value> renders inline text with no wrapper element",
    source: scene({
      defs: `<prop name="msg" type="string" default="yo">Message.</prop>`,
      root: `<div><template $value="$msg"></template></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe: `const e = q('#b'); return { hasTemplate: e.querySelector('template') !== null, text: e.textContent };`,
      result: { hasTemplate: false, text: "yo" },
    },
  },
  {
    name: "$html sanitizes: <script>, on* handlers, and javascript: URLs are stripped and do not execute",
    source: scene({
      defs: `<prop name="body" type="string" default="">Body.</prop>`,
      root: `<div class="body" $html="$body"></div>`,
      use:
        `<x-t id="b" body="<b>ok</b><script>window.__x=1</script>` +
        `<img src=x onerror='window.__x=2'><a href='javascript:window.__x=3'>l</a>"></x-t>`,
    }),
    expect: {
      probe:
        `const e = q('#b'); const img = e.querySelector('img'), a = e.querySelector('a');` +
        `return { hasBold: e.querySelector('b') !== null, scripts: e.querySelectorAll('script').length, ` +
        `imgOnerror: img ? img.hasAttribute('onerror') : null, aHref: a ? a.hasAttribute('href') : null, ` +
        `xflag: window.__x || 'unset' };`,
      result: { hasBold: true, scripts: 0, imgOnerror: null, aHref: false, xflag: "unset" },
    },
  },
  {
    name: "invalid $html expressions retain the last sanitized content",
    source: scene({
      defs:
        `<state name="width" type="length" value="8px"></state>` +
        `<handler name="invalidate"><set name="width" value="1rem"></set></handler>` +
        `<handler name="restore"><set name="width" value="2px"></set></handler>`,
      root:
        `<div><button type="button" on:click="invalidate">Invalidate</button>` +
        `<button type="button" on:click="restore">Restore</button>` +
        `<p class="element" $html="concat('&lt;b&gt;', min($width, 5px), '&lt;/b&gt;')"></p>` +
        `<span class="template"><template $html="concat('&lt;i&gt;', min($width, 5px), '&lt;/i&gt;')"></template></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); return { element: r.querySelector('.element b')?.textContent ?? null, ` +
        `template: r.querySelector('.template i')?.textContent ?? null };`,
      result: { element: "5px", template: "5px" },
      after: [
        { action: `document.querySelectorAll('#b button')[0].click();`, result: { element: "5px", template: "5px" } },
        { action: `document.querySelectorAll('#b button')[1].click();`, result: { element: "2px", template: "2px" } },
      ],
    },
  },
  {
    name: "value semantics: typed equality, invalid runtime arithmetic, boolean and/or",
    source: scene({
      defs: `<state name="textNumber" type="string" value="1"></state>`,
      root:
        `<div><i class="eq" $value="1 = '1'"></i>` +
        `<i class="arith" $value="$textNumber + 1"></i>` +
        `<i class="and" $value="'a' and 0"></i>` +
        `<i class="or" $value="0 or 'x'"></i></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); return { eq: r.querySelector('.eq').textContent, ` +
        `arith: r.querySelector('.arith').textContent, and: r.querySelector('.and').textContent, ` +
        `or: r.querySelector('.or').textContent };`,
      result: { eq: "false", arith: "", and: "false", or: "true" },
    },
  },
  {
    name: "dimensional arithmetic scales numeric parts and preserves written units",
    source: scene({
      defs:
        `<state name="width" type="length" value="8px"></state>` +
        `<state name="factor" type="number" value="2"></state>` +
        `<state name="flag" type="boolean" value="true"></state>` +
        `<computed name="half" from="$width / $factor"></computed>` +
        `<computed name="padded" from="$width + 2px"></computed>` +
        `<computed name="chosen" from="($flag ? 1px : 2px) * 2"></computed>` +
        `<handler name="scale"><set name="factor" value="4"></set><set name="flag" value="false"></set></handler>` +
        `<handler name="changeUnit"><set name="width" value="8rem"></set></handler>` +
        `<handler name="restoreUnit"><set name="width" value="12px"></set></handler>`,
      root:
        `<div><button type="button" on:click="scale">Scale</button>` +
        `<button type="button" on:click="changeUnit">Change unit</button>` +
        `<button type="button" on:click="restoreUnit">Restore unit</button>` +
        `<output $value="concat(round($half), '/', $factor * $width, '/', $padded, '/', $chosen)"></output></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe: `return q('#b output').textContent;`,
      result: "4px/16px/10px/2px",
      after: [
        { action: `document.querySelectorAll('#b button')[0].click();`, result: "2px/32px/10px/4px" },
        { action: `document.querySelectorAll('#b button')[1].click();`, result: "2rem/32rem/10px/4px" },
        { action: `document.querySelectorAll('#b button')[2].click();`, result: "3px/48px/14px/4px" },
      ],
    },
  },
  {
    name: "$if truthiness: '' / 0 / [] / false are falsy; non-empty string and non-zero are truthy",
    source: scene({
      root:
        `<div><span class="s1" $if="''"></span><span class="s2" $if="0"></span>` +
        `<span class="s3" $if="[]"></span><span class="s4" $if="false"></span>` +
        `<span class="s5" $if="'x'"></span><span class="s6" $if="1"></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); return { s1: !!r.querySelector('.s1'), s2: !!r.querySelector('.s2'), ` +
        `s3: !!r.querySelector('.s3'), s4: !!r.querySelector('.s4'), s5: !!r.querySelector('.s5'), ` +
        `s6: !!r.querySelector('.s6') };`,
      result: { s1: false, s2: false, s3: false, s4: false, s5: true, s6: true },
    },
  },
  {
    name: "invalid structural expressions keep the last rendered region until a valid update",
    source: scene({
      defs:
        `<state name="width" type="length" value="8px"></state>` +
        `<state name="clear" type="boolean" value="false"></state>` +
        `<handler name="invalidate"><set name="width" value="1rem"></set></handler>` +
        `<handler name="restore"><set name="width" value="2px"></set></handler>` +
        `<handler name="empty"><set name="clear" value="true"></set></handler>`,
      root:
        `<div><button type="button" on:click="invalidate">Invalidate</button>` +
        `<button type="button" on:click="restore">Restore</button>` +
        `<button type="button" on:click="empty">Empty</button>` +
        `<i class="conditional" $if="$clear ? [] : [min($width, 5px)]">shown</i>` +
        `<u class="alias" $with="min($width, 5px) as chosen" $value="$chosen"></u>` +
        `<template $match="min($width, 5px) as picked"><b $when="$picked = '5px'">five</b><b $else>other</b></template>` +
        `<span class="row" $each="item of ($clear ? [] : [min($width, 5px)])" $value="$item"></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); return { conditional: r.querySelector('.conditional')?.textContent ?? null, ` +
        `alias: r.querySelector('.alias')?.textContent ?? null, match: r.querySelector('b')?.textContent ?? null, ` +
        `rows: Array.from(r.querySelectorAll('.row'), (row) => row.textContent) };`,
      result: { conditional: "shown", alias: "5px", match: "five", rows: ["5px"] },
      after: [
        { action: `document.querySelectorAll('#b button')[0].click();`, result: { conditional: "shown", alias: "5px", match: "five", rows: ["5px"] } },
        { action: `document.querySelectorAll('#b button')[1].click();`, result: { conditional: "shown", alias: "2px", match: "other", rows: ["2px"] } },
        { action: `document.querySelectorAll('#b button')[2].click();`, result: { conditional: null, alias: "2px", match: "other", rows: [] } },
      ],
    },
  },
  {
    name: "initially invalid structural expressions render nothing until a valid update",
    source: scene({
      defs:
        `<state name="width" type="length" value="1rem"></state>` +
        `<handler name="restore"><set name="width" value="2px"></set></handler>`,
      root:
        `<div><button type="button" on:click="restore">Restore</button>` +
        `<i class="conditional" $if="[min($width, 5px)]">shown</i>` +
        `<u class="alias" $with="min($width, 5px) as chosen" $value="$chosen"></u>` +
        `<template $match="min($width, 5px) as picked"><b $when="$picked = '5px'">five</b><b $else>other</b></template>` +
        `<span class="row" $each="item of [min($width, 5px)]" $value="$item"></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); return { conditional: r.querySelector('.conditional')?.textContent ?? null, ` +
        `alias: r.querySelector('.alias')?.textContent ?? null, match: r.querySelector('b')?.textContent ?? null, ` +
        `rows: Array.from(r.querySelectorAll('.row'), (row) => row.textContent) };`,
      result: { conditional: null, alias: null, match: null, rows: [] },
      after: [
        { action: `document.querySelector('#b button').click();`, result: { conditional: "shown", alias: "2px", match: "other", rows: ["2px"] } },
      ],
    },
  },
  {
    name: "$if, $with and $match keep their content while the decision holds, and rebuild it when it changes",
    source: scene({
      defs:
        `<state name="count" type="number" value="1"></state>` +
        `<handler name="add"><set name="count" expr:value="$count + 1"></set></handler>` +
        `<handler name="clear"><set name="count" value="0"></set></handler>`,
      root:
        `<div><button type="button" on:click="add">Add</button><button type="button" on:click="clear">Clear</button>` +
        `<p class="if" $if="$count > 0"><input></p>` +
        `<p class="with" $with="$count as n"><input><b>{$n}</b></p>` +
        `<template $match="$count as n"><p class="small" $when="$n < 3"><input></p><p class="large" $else><input></p></template></div>`,
      use: `<x-t id="kept"></x-t>`,
    }),
    expect: {
      // Each input's region, its value, and whether it is the node typed into.
      probe: `return qa('#kept input').map((input) => [input.parentElement.className, input.value, input.typed === true]).concat([[q('#kept b').textContent]]);`,
      result: [["if", "", false], ["with", "", false], ["small", "", false], ["1"]],
      after: [
        {
          action: `for (const input of document.querySelectorAll('#kept input')) { input.value = 'typed'; input.typed = true; } document.querySelectorAll('#kept button')[0].click();`,
          result: [["if", "typed", true], ["with", "typed", true], ["small", "typed", true], ["2"]],
        },
        { action: `document.querySelectorAll('#kept button')[0].click();`, result: [["if", "typed", true], ["with", "typed", true], ["large", "", false], ["3"]] },
        { action: `document.querySelectorAll('#kept button')[1].click();`, result: [["with", "typed", true], ["small", "", false], ["0"]] },
      ],
    },
  },
  {
    name: "fault tolerance: a missing nested read removes the attribute / renders empty, never throws",
    source: scene({
      defs: `<state type="object({ a: number })" name="obj" value="{ a: 1 }"></state>`,
      root: `<div from:data-x="$obj.b.c" $value="$obj.missing"></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe: `const e = q('#b'); return { hasX: e.hasAttribute('data-x'), text: e.textContent };`,
      result: { hasX: false, text: "" },
    },
  },
  {
    name: "$each with $sort/$limit and the loop object (index/last/count), plus item, i binding",
    source: scene({
      root:
        `<ul><li $each="n, i of [3, 1, 2, 5]" $sort="n" $limit="3" ` +
        ` from:data-i="$i" from:data-last="$loop.last" from:data-count="$loop.count" $value="$n"></li></ul>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `return qa('#b li').map(li => [li.getAttribute('data-i'), li.textContent, ` +
        `li.hasAttribute('data-last'), li.getAttribute('data-count')]);`,
      result: [
        ["0", "1", false, "3"],
        ["1", "2", false, "3"],
        ["2", "3", true, "3"],
      ],
    },
  },
  {
    name: "$each $where filters and reindexes the loop",
    source: scene({
      root: `<ul><li $each="n, i of [10, 20, 30]" $where="$n > 10" from:data-i="$i" $value="$n"></li></ul>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe: `return qa('#b li').map(li => [li.getAttribute('data-i'), li.textContent]);`,
      result: [
        ["0", "20"],
        ["1", "30"],
      ],
    },
  },
  {
    name: "$sort with multiple keys and descending (a,-b)",
    source: scene({
      root: `<ul><li $each="r of [{ p: 1, q: 2 }, { p: 1, q: 1 }, { p: 2, q: 0 }]" $sort="r.p,-r.q" $value="$r.q"></li></ul>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe: `return qa('#b li').map(li => li.textContent);`,
      result: ["2", "1", "0"],
    },
  },
  {
    name: "$match/$when/$else renders only the winning arm",
    source: scene({
      defs: `<prop name="tier" type="keyword" values="free, pro" default="free">Tier.</prop>`,
      root:
        `<div><template $match="$tier as t">` +
        `<span class="t" $when="$t = 'pro'">Pro</span>` +
        `<span class="t" $else>Free</span></template></div>`,
      use: `<x-t id="b" tier="pro"></x-t>`,
    }),
    expect: {
      probe: `const r = q('#b'); return { count: r.querySelectorAll('.t').length, text: r.querySelector('.t').textContent };`,
      result: { count: 1, text: "Pro" },
    },
  },
  {
    name: "$match selects a row inside <table><tbody>, falling back to $else",
    source: scene({
      defs: `<prop name="status" type="keyword" values="ok, bad" default="ok">Status.</prop>`,
      root:
        `<table><tbody><template $match="$status as s">` +
        `<tr class="r" $when="$s = 'ok'"><td>OK</td></tr>` +
        `<tr class="r" $else><td>No</td></tr></template></tbody></table>`,
      use: `<x-t id="b" status="bad"></x-t>`,
    }),
    expect: {
      probe: `const r = q('#b'); return { rows: r.querySelectorAll('tr.r').length, text: r.querySelector('tr.r td').textContent };`,
      result: { rows: 1, text: "No" },
    },
  },
  {
    name: "a structural <template> produces no wrapper element",
    source: scene({
      root: `<div><template $if="true"><span class="x">hi</span></template></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const e = q('#b'); return { hasTemplate: e.querySelector('template') !== null, ` +
        `hasSpan: e.querySelector('.x') !== null, text: e.textContent };`,
      result: { hasTemplate: false, hasSpan: true, text: "hi" },
    },
  },
  {
    name: "$with binds an aliased expression into a child scope",
    source: scene({
      root: `<div><template $with="{ name: 'Ada' } as u"><b class="who" $value="$u.name"></b></template></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: { probe: `return q('#b .who').textContent;`, result: "Ada" },
  },
  {
    name: "reactive declarations seed once: state initializes, computed evaluates, data is pending",
    source: scene({
      defs:
        `<state name="count" type="number" value="5"></state>` +
        `<computed name="doubled" from="$count * 2"></computed>` +
        `<data name="feed"></data>`,
      root: `<div from:data-count="$count" from:data-doubled="$doubled"><i $value="$feed.pending"></i></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const e = q('#b'); return { count: e.getAttribute('data-count'), ` +
        `doubled: e.getAttribute('data-doubled'), pending: e.querySelector('i').textContent };`,
      result: { count: "5", doubled: "10", pending: "true" },
    },
  },
  {
    name: "a <style> in a definition moves to <head> and the definition template is removed",
    source: scene({
      root: `<button></button>`,
      style: `button { color: red; }`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `return { defsLeft: document.querySelectorAll('template[component]').length, ` +
        `styleInHead: document.head.querySelector('style') !== null, ` +
        `isButton: q('#b') instanceof HTMLButtonElement };`,
      result: { defsLeft: 0, styleInHead: true, isButton: true },
    },
  },
];

// ---------------------------------------------------------------------------
// Diagnostic cases: lowerDocument throws a specific stable code
// ---------------------------------------------------------------------------

const diagnostics: ConformanceCase[] = [
  {
    name: "HC003: component summary cannot be empty",
    source: `<template component="x-t" status="early" summary=""><button></button></template><x-t></x-t>`,
    expect: { code: "HC003" },
  },
  {
    name: "HP001: property bindings require a native property",
    source: scene({ root: `<button .notRealProperty="true"></button>`, use: `<x-t></x-t>` }),
    expect: { code: "HP001" },
  },
  {
    name: "HT005: two-way bindings require declared state",
    source: scene({
      defs: `<prop name="label" type="string" default="">Label.</prop>`,
      root: `<input bind:value="label">`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HT005" },
  },
  {
    name: "an absent required prop lowers with valueMissing validity",
    source: scene({
      defs: `<prop name="label" type="string" required>Label.</prop>`,
      root: `<div from:data-l="$label"></div>`,
      use: `<x-t></x-t>`,
    }),
    expect: {
      probe: `const el = q('div'); return { missing: el.validity.valueMissing, valid: el.validity.valid };`,
      result: { missing: true, valid: false },
    },
  },
  {
    name: "HR001: two definitions declare the same tag",
    source:
      `<template component="x-dup" status="early" summary="A."><button></button></template>` +
      `<template component="x-dup" status="early" summary="B."><span></span></template>` +
      `<x-dup></x-dup>`,
    expect: { code: "HR001" },
  },
  {
    name: "HC020: a name collides in the flat component namespace (prop and state)",
    source: scene({
      defs: `<prop name="count" type="number" default="0">Count.</prop><state type="number" name="count" value="1"></state>`,
      root: `<div from:data-c="$count"></div>`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HC020" },
  },
  {
    name: "HC011: prop names collide after lowercase normalization",
    source: scene({
      defs: `<prop name="Label" type="string" default="a">One.</prop><prop name="label" type="string" default="b">Two.</prop>`,
      root: `<button></button>`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HC011" },
  },
  {
    name: "HY002: structured state cannot be tested by :host-state()",
    source: scene({
      defs: `<state name="items" type="list(string)" value="[]"></state>`,
      root: `<div></div>`,
      style: `:host-state([items]) { color: red; }`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HY002" },
  },
  {
    name: "HT021: a guarded root cannot guarantee one element",
    source: scene({ root: `<button $if="false"></button>`, use: `<x-t></x-t>` }),
    expect: { code: "HT021" },
  },
  {
    name: "HT018: a $match child is neither a $when nor $else arm",
    source: scene({
      defs: `<prop name="s" type="keyword" values="a, b" default="a">S.</prop>`,
      root: `<div $match="$s as t"><span $when="$t = 'a'">A</span><div>oops</div></div>`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HT018" },
  },
  {
    name: ".property binding resolves through the generated DOM contract",
    source: scene({ root: `<button .disabled="true"></button>`, use: `<x-t></x-t>` }),
    expect: {
      probe: `const e = q('button'); return { disabled: e.disabled, hasDirective: e.hasAttribute('.disabled') };`,
      result: { disabled: true, hasDirective: false },
    },
  },
  {
    name: "HT007: a :srcdoc binding into a raw content sink",
    source: scene({
      defs: `<prop name="h" type="string" default="">H.</prop>`,
      root: `<iframe from:srcdoc="$h"></iframe>`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HT007" },
  },
  {
    name: "HT014: more than one structural directive on an element",
    source: scene({ root: `<div $if="true" $each="x of []"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT014" },
  },
  {
    name: "HT010: an inline on* executable literal attribute",
    source: scene({ root: `<button onclick="alert(1)"></button>`, use: `<x-t></x-t>` }),
    expect: { code: "HT010" },
  },
  {
    name: "HT012: an unknown $ directive",
    source: scene({ root: `<div $frobnicate="1"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT012" },
  },
  {
    name: "HT013: a malformed expression",
    source: scene({ root: `<div from:data-x="1 +"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT013" },
  },
  {
    name: "HT015: $with not written `expr as name`",
    source: scene({ root: `<div $with="$foo"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT015" },
  },
  {
    name: "HT016: $each not written `item of items`",
    source: scene({ root: `<div $each="foo"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT016" },
  },
  {
    name: "HT006: a $value directive coexists with children",
    source: scene({ root: `<h3 $value="'x'">child</h3>`, use: `<x-t></x-t>` }),
    expect: { code: "HT006" },
  },
  {
    name: "HT008: more than one slot",
    source: scene({ root: `<div><slot></slot><slot></slot></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT008" },
  },
  {
    name: "HT009: a reserved element name in markup",
    source: scene({ root: `<div><for></for></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT009" },
  },
  {
    name: "HT001: the markup is not exactly one element root",
    source:
      `<template component="x-t" status="early" summary="S."><button></button><span></span></template><x-t></x-t>`,
    expect: { code: "HT001" },
  },
  {
    name: "HS002: more than one <style> region",
    source:
      `<template component="x-t" status="early" summary="S."><button></button><style>a{}</style><style>b{}</style></template><x-t></x-t>`,
    expect: { code: "HS002" },
  },
  {
    name: "an unparseable number prop renders its default and reports badInput",
    source: scene({
      defs: `<prop name="n" type="number" default="0">N.</prop>`,
      root: `<div from:data-n="$n"></div>`,
      use: `<x-t n="abc"></x-t>`,
    }),
    expect: {
      probe: `const el = q('div'); return { value: el.getAttribute('data-n'), badInput: el.validity.badInput };`,
      result: { value: "0", badInput: true },
    },
  },
  {
    name: "HT003: an undeclared name in an expression",
    source: scene({ root: `<div $value="$nope"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT003" },
  },
  {
    name: "HC010: a <prop> without a name",
    source: scene({ defs: `<prop type="string">Desc.</prop>`, root: `<button></button>`, use: `<x-t></x-t>` }),
    expect: { code: "HC010" },
  },
  {
    name: "HC013: a <prop> without a type",
    source: scene({ defs: `<prop name="x">Desc.</prop>`, root: `<button></button>`, use: `<x-t></x-t>` }),
    expect: { code: "HC013" },
  },
  {
    name: "HC005: a component tag without a hyphen",
    source: `<template component="nohyphen" status="early" summary="S."><button></button></template>`,
    expect: { code: "HC005" },
  },
  {
    name: "HC007: an unrecognized component status",
    source: `<template component="x-t" status="bogus" summary="S."><button></button></template><x-t></x-t>`,
    expect: { code: "HC007" },
  },
  {
    name: "HC008: a root that is not a known HTML element",
    source: `<template component="x-t" status="early" summary="S."><frobnicate></frobnicate></template><x-t></x-t>`,
    expect: { code: "HC008" },
  },
];

export const cases: readonly ConformanceCase[] = [...successes, ...diagnostics];
