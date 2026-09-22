# The rendered form (design study)

Status: design study behind the normative [Rendered form](spec/rendered-form.md) module. Every claim
links to a lab script in `lab/ssr-slots/`; results are from Chromium, Firefox, and WebKit as bundled with
Playwright (September 2026). Earlier drafts below used a lab-only flag and comment markers; the runtime
now always writes the markers, and `serializeRenderedForm` and `inspectInstance` are runtime exports.

## Problem

A component instance has two serializations. The **authored form** is the invocation a consumer
writes: `<ui-dialog label="Publish?">…children…</ui-dialog>`. The **rendered form** is the lowered
native DOM, as a server renders it or as the runtime leaves it. The spec defines the authored form
and the lowering; it does not yet define the rendered form as a format of its own. Today each
implementation encodes what it needs, and after a server round trip part of the instance is lost.

The spec should define the rendered form normatively, as an alternate source of truth for the same
instance. Its invariant:

> **Round trip.** From the rendered form alone (plus the definition) the authored invocation can be
> recovered losslessly: the component tag, its explicit props, and each slot's projected content
> (or that the slot is empty and shows fallback). Rendering the recovered invocation yields the same
> rendered form.

Hydration, framework adoption, and server rendering are then implementations of this format, and the
round trip is their shared conformance oracle.

The spec already requires part of this: explicit props are reflected as `data-<name>` "so the element
shows which options produced it and server output can reconstruct the instance scope"
(`components.md`). The tag is recoverable from `data-component-root`. Slot boundaries, projected
text, and fallback state have no representation.

The format must stay small, and must not change accessibility, SEO, layout, selectors, or native
element and form behavior. Measured on a component library's docs pages, today's record is already 22-23% of
component markup, most of it `data-component` stamped on every authored element (P7).

The record has two readers with different abilities:

- **CSS** (style scoping, `:slotted()`) sees only elements and attributes, never comments or text.
- **Hydration** can read anything: attributes, comments, text positions.

## Requirements (from the spec)

- **R1 Identity.** Projected nodes keep consumer ownership and identity; hydration preserves node
  identity, edits, focus, and selection (`components.md` Slots; `live-browser-distributable.md`).
- **R2 Slot features.** Default, named, fallback, and expression-bound slot names inside structural
  regions, with keyed updates retaining projected identity (`components.md` Slots).
- **R3 Fallback state.** Fallback renders only while the projection is empty, so hydration must know
  which of the two a slot is showing.
- **R4 No wrapping.** "Nothing is reset, wrapped, or encapsulated"; `:slotted(> *)` anchors at the
  projection boundary (`styling.md`). Consumer and component selectors must see the same tree as
  without SSR.
- **R5 One structure.** The live runtime, Vanilla, React, Vue, and Svelte agree on the public DOM for
  the same inputs (`targets-and-conformance.md`).
- **R6 Parse round trip.** Server markup must parse back into the same tree in every context a slot
  may occupy (lists, tables, `select`, phrasing content).
- **R7 Accessibility and layout** are unaffected.
- **R9 Compact.** The record adds little to page weight; it is not repeated per node where one mark
  per boundary suffices.
- **R10 SEO.** Server HTML carries the real content and semantics (headings, links, text) with no
  crawler-visible artifacts.
- **R11 Native element rules.** Content-model positions keep working: `legend` as the first child of
  `fieldset`, `summary` of `details`, `caption` of `table`, options in `select`, label/control
  association, `FormData`, and `form.elements`.
- **R8 Robustness.** Hydration degrades safely when the DOM changed before it ran (extensions,
  translation tools, whitespace).

## Who needs slot boundaries from markup

- **HTML Next's own server output** (native application build, live-runtime SSR): yes. Nothing else
  knows the boundaries, and HTML Next controls the serializer.
- **Framework-owned roots** (React, Vue, Svelte targets): the framework hydrates its own DOM from its
  own render tree, and since the framework-root claim change HTML Next never re-renders a
  framework-owned root. HTML Next still needs the projected nodes for style boundaries, but the
  framework can supply them from its tree instead of HTML Next inferring them from markup.
  *Open: verify per framework (Q2).*

## Alternatives and results

| | Approach | Result |
|---|---|---|
| A | Keep `<slot>` elements as region containers (`display: contents` by UA style) | **Rejected.** Inside a foreign shadow tree the element is a live slot: it takes the host's light children and hides the projection (P3). Breaks `:empty`, `:first-child`, `>`, `+` (P4). Foster-parented out of `tbody`/`tr` (P1). |
| B | Declarative Shadow DOM on the root | **Rejected.** Shadow roots attach only to `div`, `span`, `section`, `p` and similar; not `button`, `dialog`, `select`, `input`, `ul`, `li`, `label`, `a`, `td`, `fieldset`, `form` (P9). Also contradicts R4 (encapsulation). |
| C | Comment delimiters around each region | **Survives so far.** Parser-safe in every tested context (P1); comments are inserted in place by the table and select insertion modes, so this holds for older parsers too. Selector-, layout-, and accessibility-transparent (P4, P5); native element rules and forms unaffected (P6). Risks: React cannot render comments; HTML minifiers may strip them. |
| D | Wrapper element with a generic attribute, `display: contents` | **Rejected.** Same selector breakage as A (P4) and same table foster-parenting (P1); violates R4. A wrapped `legend` no longer names its `fieldset` (P6). |
| E | HTML's light-DOM assignment rule: named content is elements with `slot="…"`, the rest is default | **Insufficient alone.** Adjacent template and projected text merge into one node on parse (P2), so boundaries are unrecoverable; named text has no carrier. |
| F | Structural matching against the template (current runtime) | **Insufficient alone.** Same text merging (P2); heuristic when several slots share a parent. |
| G | Out-of-band manifest (child indexes and text offsets) | Untested. No markup side effects if emitted once per document; fragile if the DOM changes before hydration (R8); a per-root `<script>` would count as a child (like H). |
| H | Empty `<template>` elements as boundary markers | **Weak.** Parser-safe everywhere, including `tbody`, `tr`, `select` (P1-H), but the markers are children: breaks `:empty`, `:first-child`, `+` (P4). |
| J | Processing-instruction range markers, `<?slot name="…"?>` … `<?slot-end?>` | **Leading.** Chromium (origin trial 148-150, shipping target 150) parses them as `ProcessingInstruction` nodes; Firefox and WebKit parse them as comments. Both forms survive every tested context, including `tbody`, `tr`, `select` (P8); split adjacent template and projected text (P8); and leave `:empty`, `:first-child`, `>`, `+` unchanged (P10). It is C with a standards track. |
| I | Hybrid of E and C: attributes for elements, comments only where text is ambiguous | Untested. Smaller output than C, more rules. |

Current engines parse elements inside `select` (the customizable-select parser). Older engines in
the support range (for example Safari 17.4) use the classic `select` parser, which drops non-option
elements; any element-based marker (A, D, H) would fail there. Not testable with the lab.

## Platform alignment

If the platform is ever to hydrate natively, the rendered form must use constructs browser vendors
would standardize. The precedents and current work:

- **Declarative Shadow DOM** (`<template shadowrootmode>`) is a parser-consumed marker. It proves vendors
  accept parser-level instructions, but it cannot host native roots such as `button` (P9).
- **DOM Parts** ([WICG webcomponents #1003](https://github.com/WICG/webcomponents/issues/1003)) proposed
  `<?child-node-part?>…<?/child-node-part?>` ranges for exactly this: locating nodes of interest for
  server rendering and updates.
- **Declarative Partial Updates** ([patching explainer](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md))
  uses `<?start name="…"?>…<?end?>` and `<?marker name="…"?>` ranges for streamed patches.
- **Processing instructions in HTML**: [whatwg/html#12118](https://github.com/whatwg/html/pull/12118) and
  [whatwg/dom#1454](https://github.com/whatwg/dom/pull/1454) parse `<?target data?>` as
  `ProcessingInstruction` nodes "to denote ranges … without requiring new DOM elements and changing the
  DOM structure as far as CSS is concerned". Chrome: [Intent to Experiment](http://www.mail-archive.com/blink-dev@chromium.org/msg16220.html),
  origin trial 148-150. Gecko and WebKit have no formal position yet
  ([mozilla #1369](https://github.com/mozilla/standards-positions/issues/1369),
  [webkit #628](https://github.com/WebKit/standards-positions/issues/628)); Mozilla's parser owner approved
  the HTML PR.

Constraints that follow for the rendered form:

- **Target grammar.** A PI target must start with an ASCII letter (review converged on
  `[A-Za-z][-A-Za-z0-9]*`); `<?/slot?>` is not a PI. End markers need a letter-first target. Data is an
  opaque string, never entity-decoded, and `>` always closes.
- **Two forms forever.** Old parsers make a comment whose data is `?target data?`, and old engines
  re-serialize it as `<!--?target data?-->`, which every parser, new or old, keeps as a comment (P10).
  Readers must accept both forms indefinitely.
- **No shared vocabulary collisions.** Partial Updates' `<?end?>` "closes the nearest open start". A
  rendered form that also used `start`/`end` could close, or be closed by, a page's patch ranges.
  Component ranges need their own targets.
- **CSS still cannot see them.** PIs, like comments, are invisible to selectors. Style scoping keeps
  needing attributes on elements (the CSS reader), independent of range markers (the hydration reader).

## Framework emission (P11)

| Target | Can emit range markers? | Adjacent template and projected text |
|---|---|---|
| React 19 | **No.** PIs and comments are escaped as text; raw markup needs a host element (`dangerouslySetInnerHTML`). | Kept apart: React emits `Hello <!-- -->world`. |
| Vue 3 | Comment form only, through comment vnodes: `<!--?slot name="x"?-->`. | Merged: `Hello world`. |
| Svelte 5 | Comment form with `preserveComments` (static only); PI form through `{@html}`, wrapped in Svelte's own `<!---->` anchors. | Merged: `Hello world`. |

"Every target emits the complete rendered form" is therefore impossible (React). Proposed line:

- The **element tree** of the rendered form (elements, attributes, explicit `data-<prop>`) is normative
  for every target, as R5 requires today.
- **Range markers** are hydration metadata. A renderer emits them when it hands hydration to someone
  else: HTML Next's server renderer, the Vanilla target, eventually the browser. A framework that
  hydrates its own output owns that markup; it is not browser-hydratable, and HTML Next receives the
  projected nodes from the framework's own tree when the framework attaches.

This trades part of R5 for honesty about what frameworks can express. *To be challenged in review.*

## Draft 1 format

- **Slot ranges.** Every rendered slot is delimited: `<?slot?>` for the default slot or
  `<?slot name="…"?>` (name percent-encoded) at the start, `<?slot-end?>` at the end. A slot showing
  fallback adds a `fallback` flag: `<?slot name="title" fallback?>Untitled<?slot-end?>`. An empty slot
  without fallback emits nothing. Readers accept the comment form (`<!--?slot …?-->`) as equivalent.
- **Ownership (Q6, draft 1).** A root owns the markers in its *own region*: its subtree, minus the
  contents of its own ranges (consumer content), minus the own regions of nested roots, plus the
  contents of nested roots' ranges (what this root projected into them). No owner tags.
- **Unchanged.** `data-component-root` names the component; explicit props are `data-<name>`.

Reference reader: `lab/ssr-slots/reader.js` (independent of the runtime). Prototype writer: the
`__rangeMarkers` flag in `renderSlot` (lab only).

## Oracle results, draft 1 (P12)

`10-roundtrip.mjs`, identical in Chromium, Firefox, WebKit.

| Case | Result |
|---|---|
| default text; named + default; fallback shown | slots ✓ |
| text beside template text (`Hello <slot>!`) | ✓ |
| stray default content into a component with no default slot | ✓ (not rendered, not recovered) |
| slot passthrough into a nested component (`<x-card><slot></slot></x-card>` in a template) | ✓ |
| same component nested inside its own projection | slots ✓ |
| keyed dynamic slot names under `$each` | ✓ |
| empty | slots ✓ |
| explicit prop | ✓ |
| **default prop on a template that binds `:data-tone`** | ✗ F2 |
| **consumer `id`/`class` on the root** | ✗ F4 |

Findings:

- **F1 Slot ranges and the draft-1 ownership rule hold** on every slot case, including composition.
- **F2 Explicit vs default is lost when a template binds `data-<prop>` itself.** The runtime then
  writes the effective value (defaults included), so `<x-card>` recovers as `<x-card tone="info">`.
  Either `data-<prop>` names belong to the record alone (a template may not bind them; components
  that style by effective value bind another name or style the absent case), or explicitness gets its
  own mark. The first keeps the record minimal; the second keeps existing templates (a library that binds
  `:data-variant`, `:data-size`, …). **Decision needed.**
- **F3 The runtime already writes structural markers**: `$each` renders
  `<!--html-next:each-start-->`, `<!--html-next:item-start-->`, and matching ends. They are part of the
  rendered form in practice, vendor-named, and undefined by the spec. The format must cover structural
  regions (`$each`, `$if`, `$match`) with the same marker grammar as slots.
- **F4 Consumer attributes.** Live lowering **dropped** the consumer's `class="mine"` when the template
  root has `class="card"` (runtime bug, independent of SSR). The record also cannot say which root
  attributes came from the consumer. With the definition, a reader can subtract the template's static
  and bound root attributes, if merge rules (`class` tokens, `style` declarations) are specified.

## Adversarial review of draft 1

One independent reviewer; scripts `lab/ssr-slots/review-*.mjs`. Breaks marked ✔ were re-run and
reproduced.

1. ✔ **Unrendered projections are lost.** Content for a slot under a false `$if` (or an unrendered
   `$each` row) is not in the rendered form, so it cannot be recovered, and crawlers never see it:
   `<x-if><i slot="extra">E</i>main</x-if>` recovers as `<x-if>main</x-if>`. The oracle hid this by
   filtering canonical comparison to currently rendered slots. Prior art: Qwik keeps unprojected content
   because it may be projected later.
2. ✔ **Delegated roots break the ownership rule.** A root whose element carries two lineages
   (`data-component-root="x-deleg x-card"`) holds nested unnamed ranges on one element; recovery yields
   the wrong tag and leaks x-deleg's template output as consumer content. The "slot passthrough" pass in
   P12 was vacuous: the harness read before the nested component lowered.
3. **Sanitizers remove markers but keep the root** (DOMPurify default `SAFE_FOR_XML`, sanitize-html,
   minifiers with `removeComments` after any comment-form re-serialization). The reader then recovers
   an *empty* component, silently. The Sanitizer API removes markers and the `data-*` record together.
4. ✔ **No marker grammar.** A slot named `fallback` is dropped; a consumer comment `<!--?slot-end?-->`
   closes a range early; Chromium serializes `<?slot ?>` (with a space), so bytes differ by engine.
5. **Consumer attributes collide with the record.** `data-testid` recovers as a prop; `data-tone` from a
   consumer becomes the `tone` prop; a consumer `data-component-root` is merged into lineage (forgeable).
6. **Tests narrower than claimed.** P12 used the comment form only (the PI form was later shown to
   recover identically); P8 tested `<?end?>`, the Partial Updates target this doc warns against; P12 is
   hand-picked cases, not a generated oracle.
7. ✔ **Lowered output is not always parse-stable.** A component lowered inside `<p>` to `<article>`
   (or `<dialog>`) re-parses with the `<p>` closed early. A server renderer must diagnose content-model
   violations instead of emitting them.
8. A `<slot>` inside another slot's fallback is emitted as a literal `<slot>`; F3's `html-next:*`
   comments use a second grammar.

Reviewer positions worth adopting or arguing:

- **F2:** `data-<declared prop>` belongs to the record alone; the compiler rejects template bindings of
  it on the root. Components that style by effective value lose nothing: the style transformer, which
  knows defaults, compiles `[data-tone=info]` to `:is([data-tone=info], :not([data-tone]))`. An
  explicitness mark would be a second source of truth; "equal to default means absent" breaks controlled
  props and version skew.
- **F4:** specify the merge normatively (consumer wins scalars; `class` token union; `style` appended),
  recover by subtracting what the definition produces, and reserve `data-component*` and declared-prop
  names against consumer input.
- **Vendors:** a single namespaced target with the role in its data (for example following DOM Parts'
  ChildNodePart) is likelier to be accepted than a new global target per concept. "Browser hydration"
  presupposes native declarative definitions; pitch the rendered form as the serialization of a future
  `getParts()`.
- **Framework line:** React already separates text (`Hello <!-- -->world`). Lineage plus
  framework-native separators could be the baseline for every target, with named ranges removing the
  remaining ambiguity (adjacent text slots, fallback vs empty). This challenges the "framework-owned"
  line above.

## Draft 2 direction (to test)

- Restate the invariant or carry unrendered projections (inert carrier, with its selector cost).
- Markers identify their owner relative to the root element, covering delegated and nested roots.
- The root declares its range count; a reader that finds a mismatch refuses (HR005) instead of
  recovering an empty component.
- One marker grammar (ordered tokens, percent-encoded names, balanced within one parent) for slots and
  structural regions, under one namespaced target; serializers neutralize consumer comments and PIs that
  collide with it.
- F2 and F4 as above; parse-stability diagnostics for lowered output.
- A generated oracle, run in both marker forms, that settles lowering before reading.

## Marker grammar (settled by the standards)

- **Attributes on PIs are standard.** [whatwg/dom#1454](https://github.com/whatwg/dom/pull/1454) (merged
  June 2026) gives `ProcessingInstruction` an attribute map with `getAttribute`, `setAttribute`,
  `hasAttribute`, `removeAttribute`, `toggleAttribute`. "Update attributes from data" parses the data with
  the [xml-stylesheet pseudo-attribute rules](https://www.w3.org/TR/xml-stylesheet/): every attribute is
  `Name S? "=" S? PseudoAttValue`, values quoted (`"` or `'`), no duplicates. Any error leaves the
  attribute map **empty**. Chromium 153 conforms: a bare `slot` or `fallback`, or an unquoted value, yields
  no attributes at all (P13).
- **Targets need a leading letter** ([whatwg/html#12118](https://github.com/whatwg/html/pull/12118)):
  `<?/slot?>` stays a comment in every engine (P13).
- **Vocabulary.** Reuse Declarative Partial Updates' `start`, `end`, `marker` targets; distinguish
  component ranges by a `slot` attribute (a bare `<?start?>` is a page's patch range):

| Case | Marker |
|---|---|
| default slot | `<?start slot=""?>…<?end?>` |
| named slot | `<?start slot="title"?>…<?end?>` |
| slot showing fallback | `<?start slot="title" fallback=""?>…<?end?>` |
| empty slot, no fallback | `<?marker slot="title"?>` |

Firefox 155 and WebKit 26.6 parse all of these as comments; readers apply the same pseudo-attribute rules
to the comment data.

## Decided

- **Marker grammar**: the table in "Marker grammar" above. Real `ProcessingInstruction` nodes with
  standard attributes; comment form accepted where PIs are not parsed.
- **Framework targets**: frameworks hold their own state and hydrate from it. Framework-rendered markup is
  framework-owned and need not be browser-recoverable; the element tree stays normative for every target.

## Draft 2 (P14)

Changes from draft 1:

- Writer emits PIs (`createProcessingInstruction`); every rendered slot leaves a mark, including
  `<?marker slot="…"?>` for an empty slot.
- Reader parses data with the pseudo-attribute rules; honors comments as markers only in engines that do
  not parse PIs; pairs every `start`/`end` (a page's partial-update ranges are transparent); resolves
  delegated roots by lineage order on the root element (outermost first; each outer component's ranges
  sit inside the next inner one's); refuses with HR005 when a definition has slots but its rendered form
  has no marks.
- Oracle settles lowering before reading, no longer filters out declared-but-unrendered slots, and checks
  tags as well as slots.

Result (`15-roundtrip-v2.mjs`), Chromium 153 (PI form), Firefox 155 and WebKit 26.6 (comment form):
16 of 19 cases pass in every engine, including delegated roots, a slot named `fallback`, names needing
escapes, settled composition, a page's partial-update range inside slot content, and stripped-marker
detection. Remaining:

- **Consumer comment that looks like a marker** (`<!--?end?-->`), comment-form engines only. In PI engines a
  real comment is never read as a marker. Needs a serializer rule: a conforming serializer must not emit a
  consumer comment whose data parses as a component mark (in comment form it is indistinguishable).
- **Decision 1** (content for a slot that is not currently rendered) and **decision 2** (`data-<prop>`
  owned by the record) are open, and fail as expected.

## The invariant, restated: same instance (P15)

Recovering the authored markup as a string is the wrong test. The requirement is:

> **Equivalence.** A server-rendered form plus the definition must build the same internal instance as
> the authored markup plus the definition: the same definition, the same prop values and explicitness,
> the same projected nodes for every slot (rendered or not), the same state. Any later change (a prop,
> a controller or handler changing state, a new `$each` row) must then produce the same DOM.

Why it rules out losing content that no slot currently renders: authored `<x-if><i slot="extra">E</i>…`
lowers into an instance that *holds* the `<i>` even while `$if="open"` is false; when a controller or
handler opens it, the consumer's `<i>` appears. If the server output omitted it, the hydrated instance
would show the fallback instead. The two instances differ, so the rendered form must carry it. The same
holds for `$each` rows that do not exist yet and for slot names computed from state. It also forces
decision 2: a template-bound `data-<prop>` makes a hydrated prop explicit where the lowered one was not,
and an explicit (controlled) prop "is authoritative while present".

### The carrier

Serialization appends an inert `<template>` to each component root holding the projected nodes that no
slot currently renders. Precedent: `getHTML({ serializableShadowRoots })` writes a `<template
shadowrootmode>` that the live DOM does not hold, and the parser consumes it. The carrier exists only in
the serialized form: the lowered live DOM never contains it, and hydration removes it, so selectors see
the same tree in both paths. It needs no name: template output is always stamped with `data-component`
and rendered consumer content is always inside a slot range, so an unstamped root-level `<template>`
outside every range can only be the carrier.

### Hydration changes (lab prototype)

- **Marker-driven projection.** The projected nodes are the contents of the root's own non-fallback
  ranges plus the carrier's nodes; the carrier is removed. Each slot, as the template is walked, adopts
  the next range whole (markers, then the consumer's nodes or the adopted fallback), so positional
  adoption no longer misaligns after a slot or deletes the markers.
- **Nested components (pre-existing bug).** Hydrating a component whose template contains another
  component replaced the nested, already-lowered root with a raw invocation, losing the nested instance
  (reproduced with markers off: `18-nested-hydration-baseline.mjs`). Hydration now adopts the nested root
  and binds the outer definition's nodes where lowering put them: inside the nested root's slot ranges
  or its carrier.
- **Marker node type matches the parser.** Where the parser does not produce PIs, the writer creates the
  comment the parser would, so lowered and hydrated DOMs hold the same nodes.

### Results

`17-equivalence-v2.mjs` compares the internal instance, the live DOM, and the DOM after the same later
change, in Chromium 153 (PI form), Firefox 155 and WebKit 26.6 (comment form). All pass in every engine:

- named + default slots, then a prop change
- text beside template text
- fallback shown
- a slot under `$if`, opened by a prop
- a slot under `$if`, opened by a click handler changing state
- an `$each` row added later
- slot passthrough into a nested component

Still failing, as expected: a template that binds `data-<prop>` (decision 2). HTML Next's existing suites
pass unchanged with the prototype (unit 173, targets 225, browser 274).

## Lab

| Script | Tests |
|---|---|
| `01-parser.mjs` | P1: each shape parsed in `button`, `dialog`, `select`, `ul`, `tbody`, `tr`, `td`, `p`, `a`, `label`, `summary`, `dl` |
| `02-behaviour.mjs` | P5: `select` options, accessibility tree, flex and grid layout per shape |
| `03-pressure.mjs` | P2 text merging, P3 foreign shadow roots, P4 selector side effects, P9 DSD hosts, H markers |
| `05-verbosity.mjs` | P7: share of lowered component markup spent on the record (Dialog page 23%, Tree page 22%) |
| `06-processing-instructions.mjs` | P8: J markers per context and engine; node type, placement, text split |
| `07-pi-selectors.mjs` | P10: J markers under the P4 selector checks; serialization per engine |
| `08-framework-emission.mjs`, `09-svelte-emission.mjs` | P11: React, Vue, Svelte SSR emission of markers and adjacent text |
| `10-roundtrip.mjs`, `reader.js` | P12: round-trip oracle for draft 1 |
| `11-end-marker.mjs`, `12-pi-attributes.mjs`, `13-pi-attribute-detail.mjs` | P13: end-marker spellings; PI attribute API and pseudo-attribute parsing per spelling |
| `14-pi-create.mjs` | PI creation and serialization per engine |
| `15-roundtrip-v2.mjs`, `reader.js` | P14: draft-2 oracle |
| `16-equivalence.mjs` | P15: the divergence before the carrier |
| `17-equivalence-v2.mjs` | P15: internal-instance equivalence oracle |
| `18-nested-hydration-baseline.mjs` | nested-component hydration with markers off (pre-existing bug) |
| `04-native-rules.mjs` | P6: `legend`, `summary`, `caption` positions, label/control, `FormData`, `form.elements`, accessibility names |

## Open questions

- **Q1** Comment attacks: minifiers, translation tools and extensions editing the DOM before
  hydration, comment syntax that cannot collide with content, nested components, fallback encoding.
- **Q2** Can each framework target hand HTML Next its projected nodes from its own tree, with no
  markup markers? React is the hard case (no DOM refs for arbitrary children).
- **Q3** Does anything besides style boundaries need projected nodes on a framework-owned root?
- **Q4** Which parts of today's record exist only for CSS (per-element `data-component` lineage) and
  could be derived instead, so the rendered form is complete *and* smaller?
- **Q6** Composition. When component X passes its slot into a nested component Y
  (`<y-card><slot></slot></y-card>` in X's template), X's range sits inside Y's range, and consumer
  content may itself contain component roots with ranges. Ownership of every marker must be decidable
  from markup alone, without owner tags that nested instances of one component would make ambiguous.
- **Q5** Round-trip oracle: generate invocations (every slot kind, text next to template text,
  several slots per parent, fallback, nested components, `$each` with keyed slot names), render,
  serialize, parse, recover, compare.
