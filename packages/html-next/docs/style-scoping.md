# Style scoping: implementation

How this package realizes the [styling contract](https://nextwebwg.org/declarative-components/styling). The
contract is the source of truth; this note only records how the tooling meets it.

## Markers

- `data-component="tag"` is on a component's root, and only its root. A delegated root (one whose
  markup root is another component) lists every owner: `data-component="x-primary x-base"`.
- `data-slotted` is on each top-level projected node.
- `data-<tag>-state="name=value name"` carries the resolved props and state the definition's
  `:host-state()` rules test, and nothing else. A truthy value adds the bare `name`; a string or
  number adds `name=<URI-encoded value>`.

## Compilation

A style block compiles to two scopes:

```css
@scope ([data-component~="x-card"]) to ([data-component], [data-slotted]) { /* own rules */ }
@scope ([data-component~="x-card"]) to ([data-component]) { /* :slotted() rules */ }
```

- `:host` becomes `:scope:where([data-component~="tag"])`. The zero-specificity qualifier
  prevents Firefox from retaining another root's scoped style during dynamic root replacement.
- `:host-state([name="value"])` becomes tokens of the state attribute; names must be declared
  props or state of a scalar type (HY001, HY002).
- `:slotted(X)` matches projected content at any depth:
  `:where([data-slotted], [data-slotted] *):is(X)`.
- A component tag in a selector matches its lowered root with type specificity:
  `:is(x-card, :where([data-component~="x-card"]))`.
- `:scope` is not authoring syntax (HY003).
- `:valid`, `:invalid`, and `:user-invalid` also match the validity runtime's mirrors.
- `@keyframes`, `@font-face`, `@property`, and other name-defining rules keep their authored
  order and conditional/layer context. Native `@scope` allows them; their names remain global.
- Own selector lists containing pseudo-elements get a zero-specificity boundary guard so
  Firefox cannot match projected or nested-component roots through a scope limit.

The browser runtime needs no CSS parser. It renames `:slotted(` and `:host-state(` into selectors
the browser accepts, parses the block twice with `CSSStyleSheet`, drops the other scope's rules from
each copy, and rewrites the remaining selectors through the CSS Object Model
(`src/component-styles.ts`). Build tools run the same steps over postcss
(`src/component-styles-build.ts`).

## Shared CSS resources

Author shared CSS with an ordinary import inside the component's style block:

```html
<style>
  @import "../styles/defaults.css";
  :host { padding: 1rem; }
</style>
```

`loadNodeComponents()` and `startBrowserComponents()` resolve the stylesheet graph before
compilation. The live loader parses imports in an inert document; Node uses PostCSS. Each
resource's final URL remains the base for its imports and assets. Vite uses its CSS resolver
for aliases and packages, and processes rebased assets through its ordinary CSS pipeline.
Synchronous compilation diagnoses unresolved imports (HY004); it never emits a global import
as a fallback. `NodeLoaderOptions` accepts a host CSS resolver, stylesheet reader, and asset
URL mapper, and the returned graph lists `stylesheetInputs` for dependency watching.
Each stylesheet keeps its own namespace environment. The tools replace authored prefixes
with stable, URI-derived prefixes and make default namespace constraints explicit on selectors
before combining sheets. Named declarations move to the combined stylesheet's preamble,
including when the imported rules use layers or conditions. Namespace URIs remain identifiers;
they are never resolved as asset URLs. Plain Node hosts must map asset URLs to deployment URLs with `stylesheetAssetURL` when file URLs are not
served by their integration.

Resolved definitions retain local `css` and separate `stylesheets`. Compatible occurrences
share one emitted body with a scope listing all adopting component roots. Prop and state
selectors include each adopter's own attribute tests. Conditions, anonymous layers, opposing
import orders, global-name overrides, and delegated-root overlap can require separate scoped
occurrences. Resource bytes are fetched once even when several occurrences are necessary.
`compileComponentGraphStylesForBuild()` delivers these occurrences and local overrides in
graph definition order, matching live installation and SSR. DOM moves and repeated instances
never reorder style carriers. Vite emits one graph CSS module so module traversal cannot
reorder a component's shared imports relative to another definition's overrides.

React output shares graph CSS in the same way. Vue and Svelte put a component's imported CSS in
its own `<style>`, within the same component/slot boundaries as its inline CSS; framework
scoping never becomes document-wide ordinary selectors.

Defaults are explicit author CSS. For example, `:host, *, :host::before, :host::after,
*::before, *::after { box-sizing: border-box; }` covers elements and pseudo-elements. `*`
does not select pseudo-elements, and `box-sizing` is not normally inherited. Scope limits
selector matching; an explicit `inherit` still reads the DOM parent's value.

Firefox 155 has a native SVG scope-limit defect: a scoped class rule can match a rect below
an excluded SVG subtree. It also reproduces without namespace declarations or HTML Next.
[Mozilla bug 2080046](https://bugzilla.mozilla.org/show_bug.cgi?id=2080046) contains the reduced
case. From alpha.40, compiled CSS prevents the leak using a private inherited
`--html-next-scope-owner` marker inside `@supports (-moz-appearance: none)`. Component
roots, projection regions and nested boundaries have distinct marker values. Priority on
root/projection markers keeps layered imports from overriding the normal boundary reset.
This property is reserved for the tools; author properties still inherit normally.

Live loading installs one independent common reset per document; closed graph CSS includes
one outside authored import conditions. Mixing live and precompiled delivery can retain both
copies because an application can disable or condition the precompiled sheet independently.
Each definition supplies its root identity. Vue and Svelte bound their scopes with classes,
which the defect leaves alone, and tell projected content apart by their own scoping: Vue's scope
attributes and Svelte's hash class. No mutation observer or new element ownership attribute is needed.
Browser tests assert compiled exclusion in every engine and retain the independent native
fixture as evidence of the platform defect.

## Delivery and hydration

Compilation transforms owned component source once. Validation never scans application
stylesheets, observes stylesheet mutations, copies rules into a companion, or patches CSSOM methods.
An application can explicitly call `rewriteValiditySelectors(css)` on selected shared CSS before
delivering it. Do not apply that source transform again to compiled CSS.

The live runtime marks each emitted style with its component tag and the names its state selectors
test. Preserve these markers in server output. Hydration reuses a marked style or stylesheet link
already in the document head, without reading its CSS rules or transforming/injecting another copy.
The document's definition registry continues to prevent installation on subsequent lowering passes.

A bundling/SSR integration can list several tags on one carrier and merge their state-name records:

```html
<link rel="stylesheet" href="/assets/components.css"
      data-html-next-component-styles="x-card x-dialog"
      data-html-next-style-states='{"x-card":["selected"],"x-dialog":["open"]}'>
```

`data-html-next-component-styles` is a whitespace-separated list of component tags whose CSS has
already been compiled into that carrier. `data-html-next-style-states` is a JSON object mapping
each tag to an array of the declared mutable/computed state names tested by its CSS. A component with no state
selectors has an empty array; an omitted record is also treated as empty. Preserve the compiler's
records when combining sheets. These are tooling metadata, supplied by the integration that owns
CSS delivery. An unmarked sheet does not assert ownership and cannot suppress injection.

Node's `renderComponents()` returns `styleOwnership` alongside `html` and `css`. Use its keys for
the carrier's component tag list and its JSON representation for the state metadata attribute.
When combining several render results, combine their CSS in application order and merge the
ownership records. Deliver each component version once.

The delivery integration owns link loading and stylesheet order. Publish the compiled CSS before
the corresponding markup can paint. Native builds import extracted CSS and register definitions
with empty CSS, so those definitions never ask the runtime to inject another copy. The build plugin
delivers the generated, scoped CSS artifact.

See [the measured delivery experiments](style-delivery-performance.md) for traces, containment
results, and early/late loading comparisons.

## Vue

Converted components use `<style scoped>` with a native scope that excludes nested component
roots. `:host` becomes `:scope`; prop and state tests add the generated root's state tokens.
Vue's own `:slotted()` handles projected content.

## Svelte

Converted components carry their styles in their `<style>`, in Vue's native scope: rooted at the
component's tag as a class, and limited by the tag classes of the components it invokes. Each
selector is `:global()`, so Svelte keeps rules for markup it cannot see, such as sanitized HTML.
In a component with slots, a selector's subject also tests Svelte's hash class, which Svelte puts
on the component's own markup and not on content a consumer projects: `:where(*)` for ordinary
selectors, and `:not(:scope, * *)` for `:slotted()`. Sanitized HTML there carries
`data-html-next-owner`. `:host` is `:scope`, and keyframes keep their names. A `:slotted()` rule
also reaches into components the consumer projects.

## Proof

`tests/platform-scoping.test.ts` checks the platform behavior this relies on in Chromium, Firefox,
and WebKit.
