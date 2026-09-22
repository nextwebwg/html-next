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
    name: "lowers to native root with prop :attr, passthrough attrs, and default slot",
    source: scene({
      tag: "x-btn",
      defs: `<prop name="label" type="string" required>Label.</prop>`,
      root: `<button type="button" :aria-label="label"><slot></slot></button>`,
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
      root: `<button type="button" role="button" class="base" style="color: red" :aria-label="label"></button>`,
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
      root: `<button :aria-expanded="open" :hidden="gone" :contenteditable="edit"></button>`,
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
      defs: `<prop name="isWide" type="boolean" default="true">Wide.</prop><state name="toneName" :value="'warm'"></state>`,
      root: `<div></div>`,
      style: `:host-state([isWide]) { width: 123px; } :host-state([toneName="warm"]) { height: 45px; }`,
      use: `<x-camel-state id="c"></x-camel-state>`,
    }),
    expect: {
      probe: `const c = q('#c'); const style = getComputedStyle(c); return [c.getAttribute("data-x-camel-state-state"), style.width, style.height];`,
      result: ["isWide toneName toneName=warm", "123px", "45px"],
    },
  },
  {
    name: "applies a prop default when the invocation omits the prop",
    source: scene({
      defs: `<prop name="label" type="string" default="Hi">Label.</prop>`,
      root: `<button :data-label="label"></button>`,
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
        `<prop name="kind" type="a | b" default="a">Enum.</prop>` +
        `<prop name="s" type="string" default="">String.</prop>`,
      root: `<div :data-sum="n + 1" :data-flag="flag" :data-kind="kind" :data-s="s"></div>`,
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
      root: `<div :data-missing="missing" :data-off="flag" :data-on="not flag" :data-num="3" :class="['a', 'b']"></div>`,
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
        `<button on:click="foo" $value="v"></button>` +
        `<span on:connect="c" on:disconnect="d"></span></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: {
      probe:
        `const r = q('#b'); const o = r.querySelector('output'), btn = r.querySelector('button'), sp = r.querySelector('span');` +
        `return { bound: o.getAttribute('value'), btnText: btn.textContent, ` +
        `btnHasOn: btn.hasAttribute('on:click'), spanHasConnect: sp.hasAttribute('on:connect'), ` +
        `spanHasDisconnect: sp.hasAttribute('on:disconnect') };`,
      result: {
        bound: "x",
        btnText: "x",
        btnHasOn: false,
        spanHasConnect: false,
        spanHasDisconnect: false,
      },
    },
  },
  {
    name: "$value renders escaped text (a <b> in data is literal characters)",
    source: scene({
      defs: `<prop name="body" type="string" default="">Body.</prop>`,
      root: `<p $value="body"></p>`,
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
      root: `<div><template $value="msg"></template></div>`,
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
      root: `<div class="body" $html="body"></div>`,
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
      result: { hasBold: true, scripts: 0, imgOnerror: false, aHref: false, xflag: "unset" },
    },
  },
  {
    name: "value semantics: typed equality, numeric-only arithmetic, boolean and/or",
    source: scene({
      root:
        `<div><i class="eq" $value="1 = '1'"></i>` +
        `<i class="arith" $value="'1' + 1"></i>` +
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
    name: "fault tolerance: a missing nested read removes the attribute / renders empty, never throws",
    source: scene({
      defs: `<state name="obj" :value="{ a: 1 }"></state>`,
      root: `<div :data-x="obj.b.c" $value="obj.missing"></div>`,
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
        `:data-i="i" :data-last="loop.last" :data-count="loop.count" $value="n"></li></ul>`,
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
      root: `<ul><li $each="n, i of [10, 20, 30]" $where="n > 10" :data-i="i" $value="n"></li></ul>`,
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
      root: `<ul><li $each="r of [{ p: 1, q: 2 }, { p: 1, q: 1 }, { p: 2, q: 0 }]" $sort="p,-q" $value="r.q"></li></ul>`,
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
      defs: `<prop name="tier" type="free | pro" default="free">Tier.</prop>`,
      root:
        `<div><template $match="tier as t">` +
        `<span class="t" $when="t = 'pro'">Pro</span>` +
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
      defs: `<prop name="status" type="ok | bad" default="ok">Status.</prop>`,
      root:
        `<table><tbody><template $match="status as s">` +
        `<tr class="r" $when="s = 'ok'"><td>OK</td></tr>` +
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
      root: `<div><template $with="{ name: 'Ada' } as u"><b class="who" $value="u.name"></b></template></div>`,
      use: `<x-t id="b"></x-t>`,
    }),
    expect: { probe: `return q('#b .who').textContent;`, result: "Ada" },
  },
  {
    name: "reactive declarations seed once: state reads a prop, computed evaluates, data is pending",
    source: scene({
      defs:
        `<prop name="start" type="number" default="3">Start.</prop>` +
        `<state name="count" :value="start"></state>` +
        `<computed name="doubled" from="count * 2"></computed>` +
        `<data name="feed"></data>`,
      root: `<div :data-count="count" :data-doubled="doubled"><i $value="feed.pending"></i></div>`,
      use: `<x-t id="b" start="5"></x-t>`,
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
    name: "HC020: a required prop is not provided",
    source: scene({
      defs: `<prop name="label" type="string" required>Label.</prop>`,
      root: `<button :data-l="label"></button>`,
      use: `<x-t></x-t>`,
    }),
    expect: { code: "HC020" },
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
      defs: `<prop name="count" type="number" default="0">Count.</prop><state name="count" :value="1"></state>`,
      root: `<div :data-c="count"></div>`,
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
    name: "HT018: a $match child is neither a $when nor $else arm",
    source: scene({
      defs: `<prop name="s" type="a | b" default="a">S.</prop>`,
      root: `<div $match="s as t"><span $when="t = 'a'">A</span><div>oops</div></div>`,
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
      root: `<iframe :srcdoc="h"></iframe>`,
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
    source: scene({ root: `<div :data-x="1 +"></div>`, use: `<x-t></x-t>` }),
    expect: { code: "HT013" },
  },
  {
    name: "HT015: $with not written `expr as name`",
    source: scene({ root: `<div $with="foo"></div>`, use: `<x-t></x-t>` }),
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
    name: "HR002: a non-finite number prop invocation value",
    source: scene({
      defs: `<prop name="n" type="number" default="0">N.</prop>`,
      root: `<div :data-n="n"></div>`,
      use: `<x-t n="abc"></x-t>`,
    }),
    expect: { code: "HR002" },
  },
  {
    name: "HT003: an undeclared name in an expression",
    source: scene({ root: `<div $value="nope"></div>`, use: `<x-t></x-t>` }),
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
