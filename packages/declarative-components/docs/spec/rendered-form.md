# Rendered form

A component instance has two serializations. The **authored form** is the invocation a consumer
writes, `<x-card tone="warn"><b slot="title">T</b>Body</x-card>`. The **rendered form** is the lowered
native DOM, as the runtime leaves it or as a server renders it. This module defines the rendered form,
so that server-rendered markup can be hydrated into the same instance the authored form lowers into.

The design study, the alternatives rejected, and the lab evidence behind each rule are in
[`../ssr-slot-hydration.md`](../ssr-slot-hydration.md).

## Equivalence

A rendered form plus the definition must build the **same instance** that the authored form plus the
definition builds:

- the same definition, prop values, and set of explicit props;
- the same projected nodes for every slot, including slots the template does not currently render;
- the same declared state.

Consequently, the same later change (a prop write, a handler or controller changing state, a new
`$each` row) produces the same DOM in both. Serialization details a consumer cannot observe are not part
of equivalence; order across different slots is not observable, order within a slot is.

## Slot range markers

Every slot the template renders is delimited in the rendered form by processing instructions:

| Case | Rendered form |
|---|---|
| Default slot | `<?start slot=""?>` … `<?end?>` |
| Named slot | `<?start slot="title"?>` … `<?end?>` |
| Slot showing its fallback | `<?start slot="title" fallback=""?>` … `<?end?>` |
| Slot rendered empty, no fallback | `<?marker slot="title"?>` |

- The data of `start` and `marker` follows the pseudo-attribute syntax: `name="value"` pairs, values
  quoted, no duplicates. A bare attribute (`slot`, `fallback`) is a parse error that leaves the
  instruction with **no** attributes, so the default slot is written `slot=""` and the flag
  `fallback=""`. Values escape `&`, `<`, `>`, and `"` as character references.
- A `start` or `marker` is a component slot mark only when it carries a `slot` attribute. A `start`
  without one (for example a page's partial-update range) is not.
- Every `start` pairs with the nearest following unpaired `end` among its siblings, whatever it marks.
  A slot range therefore begins and ends in the same parent, and ranges nest properly, including a
  page's own `start`/`end` ranges inside slot content.
- The runtime writes markers whenever it renders a slot: at lowering, and at every later render.

### Where processing instructions are not parsed

A parser that does not produce `ProcessingInstruction` nodes parses the same text as a comment whose
data is `?target data?` (the trailing `?` may be absent, and engines that serialize a PI with `>` drop it).
Such engines also serialize comment-form markers as `<!--?start slot=""?-->`, which every parser keeps
as a comment. Therefore:

- a reader **must** accept the comment form, applying the same pseudo-attribute rules to its data;
- a reader **must not** treat a comment as a mark in a document whose parser produces PIs, where a real
  comment is consumer content;
- a writer in a document whose parser does not produce PIs **must** create the comment the parser would,
  so a lowered DOM and a hydrated DOM hold the same nodes;
- a serializer **must not** emit consumer content whose comments would parse as a component mark in
  comment form.

Rendered-form markers are not public DOM. Target-equivalence snapshots exclude them, as they exclude
comments.

## Ownership

A root owns the marks in its **own region**: its subtree, minus the contents of its own slot ranges
(consumer content), minus the own regions of nested component roots, plus the contents of nested roots'
slot ranges (what this root's template projected into them). No mark names its owner.

A root that carries several lineages (`data-component-root` lists the delegating component first)
resolves them outermost last: the innermost component owns the marks in the element's own region, and
each outer component owns the marks inside the next inner component's ranges.

## Unrendered projection

Projected nodes that no slot currently renders (a slot under a false `$if`, content for an `$each` row
that does not exist yet, a slot name computed from state) are part of the instance and must survive
serialization.

The serializer appends, as the last child of each component root that has any, an inert `<template>`
whose content holds those nodes in authored order. This **carrier** exists only in serialized output,
like the `<template shadowrootmode>` that `getHTML({ serializableShadowRoots: true })` writes for a shadow
root. The lowered live DOM never contains it, and hydration removes it. It needs no name: template output
is always stamped with `data-component`, and rendered consumer content is always inside a slot range, so
an unstamped `<template>` child of the root outside every range is the carrier.

The runtime exposes `serializeRenderedForm(container)`.

## Hydration

Hydrating a server-rendered root (one carrying `data-component-root`) builds its instance from the
rendered form:

1. Read explicit props from `data-<name>` attributes, as for any hydration.
2. Collect the root's own slot ranges in document order (see Ownership).
3. The projected nodes are the contents of every range without `fallback`, each assigned the range's
   slot, followed by the carrier's nodes, which keep their own `slot` attribute (text and other
   unattributed nodes belong to the default slot). The carrier is removed.
4. Walk the template against the existing DOM. Each rendered slot adopts the next range whole: its
   markers and either the projected nodes or, for a `fallback` range, the fallback nodes, adopted in place
   so their bindings attach. A `marker` adopts as an empty slot.
5. When the template reaches a nested component invocation and the DOM holds that component's root at
   that position, the root is adopted, not re-rendered. The outer template's children of that
   invocation are matched against the nested root's slot ranges (and its carrier), which is where
   lowering placed them, so the outer definition's bindings attach to the same nodes. The nested root
   hydrates as its own instance.

A root with no slot marks (for example output of a framework target, or output from before this
revision) is hydrated structurally: nodes stamped with the component's lineage are template output and
the rest is projected content. A reader that recovers an invocation for tooling and finds a definition
with slots but no marks in the root's own region **must** fail (HR005) rather than report an empty
projection; a sanitizer that strips comments and processing instructions produces exactly that shape.

## Framework-owned output

A framework target hydrates its own output from its own state and owns that markup. It need not emit
slot marks, and framework-rendered markup is not required to be browser-recoverable. Its element tree
stays subject to target equivalence.

## Open issues

- **Explicitness of props a template binds.** When a template binds `data-<name>` for one of its own
  props, the rendered form cannot distinguish an explicit prop from its default, so a hydrated instance
  can hold an explicit (controlling) prop where the lowered one held none. This violates Equivalence.
  Resolution pending: reserve `data-<prop>` for the record, or record explicitness separately.
- **Structural-region anchors.** `$if`, `$each`, and `$match` anchors are comments named after the
  implementation (`html-next:start`, `html-next:item-start`, …). They should move to the marker grammar
  above.
- **Consumer attributes on the root.** Merge rules for `class` and `style` between template and consumer
  are unspecified, so their origin cannot be recovered from the rendered form.

## Provenance of the syntax

Every construct above comes from existing or in-progress web platform work:

- **Processing instructions in HTML.** [whatwg/html#12118](https://github.com/whatwg/html/pull/12118)
  parses `<?target data?>` as a `ProcessingInstruction` node instead of a bogus comment. The target must
  begin with an ASCII letter (so `<?/slot?>` remains a comment), `>` always closes the instruction, and
  `xml` and `xml-stylesheet` targets stay comments. Motivation, per Chrome: denoting ranges "without
  requiring new DOM elements and changing the DOM structure as far as CSS is concerned". Chrome:
  [Intent to Prototype](http://www.mail-archive.com/blink-dev@chromium.org/msg15714.html),
  [Intent to Experiment](http://www.mail-archive.com/blink-dev@chromium.org/msg16220.html) (origin
  trial 148 to 150); parsed by default in Chromium 153. Gecko and WebKit have no position yet:
  [mozilla/standards-positions#1369](https://github.com/mozilla/standards-positions/issues/1369),
  [WebKit/standards-positions#628](https://github.com/WebKit/standards-positions/issues/628).
- **Attributes on processing instructions.** [whatwg/dom#1454](https://github.com/whatwg/dom/pull/1454)
  (merged June 2026) gives `ProcessingInstruction` an attribute map with `getAttribute`, `setAttribute`,
  `hasAttribute`, `removeAttribute`, and `toggleAttribute`, kept in sync with `data`. Its "update
  attributes from data" algorithm applies the
  [xml-stylesheet rules for parsing pseudo-attributes](https://www.w3.org/TR/xml-stylesheet/), where a
  pseudo-attribute is `Name S? "=" S? PseudoAttValue` with a quoted value, duplicates are errors, and any
  error leaves the attribute map empty.
- **`start`, `end`, `marker`.** The target vocabulary of
  [Declarative Partial Updates](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md)
  (WICG), where `<?start name="…"?>…<?end?>` delimits a patchable range, `<?end?>` closes the nearest open
  `start`, and `<?marker name="…"?>` marks a point. Component ranges use a `slot` attribute rather than
  `name`, so they are never patch targets.
- **Ranges of child nodes as a platform concept.** [DOM Parts](https://github.com/WICG/webcomponents/issues/1003)
  (WICG) proposed `<?child-node-part?>…<?/child-node-part?>` for locating nodes of interest during server
  rendering and updates. Its end syntax predates the target grammar above.
- **Serialization-only structures.** [`getHTML()`](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#dom-element-gethtml)
  with `serializableShadowRoots` and
  [`<template shadowrootmode>`](https://html.spec.whatwg.org/multipage/scripting.html#attr-template-shadowrootmode)
  (Declarative Shadow DOM) establish a serialized form holding structure the live DOM does not, consumed
  by the parser; the carrier follows that model.
- **Selector transparency.** [Selectors Level 4 `:empty`](https://www.w3.org/TR/selectors-4/#the-empty-pseudo):
  comments and processing instructions do not affect emptiness.
- **Prior art.** Qwik keeps projected content that is not currently rendered because it may be projected
  later ([Qwik projection](https://qwik.builder.io/docs/components/projection/)). Lit's server rendering
  marks parts with comments whose data begins with `?lit$`, which the HTML processing-instruction change
  deliberately keeps as comments ([whatwg/html#12118](https://github.com/whatwg/html/pull/12118)
  discussion).
