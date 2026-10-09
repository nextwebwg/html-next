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
Shared resources containing `@namespace` currently produce HY004: flattening their
stylesheet-local namespace environments would change selector matching. Plain Node hosts
must map asset URLs to deployment URLs with `stylesheetAssetURL` when file URLs are not
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

React output shares graph CSS in the same way. Svelte's ownership-based slot limits and Vue's
generated scope IDs can require separate transformed occurrences. Their imported CSS follows
the same component/slot boundaries as their inline CSS; framework scoping never becomes
document-wide ordinary selectors.

Defaults are explicit author CSS. For example, `:host, *, :host::before, :host::after,
*::before, *::after { box-sizing: border-box; }` covers elements and pseudo-elements. `*`
does not select pseudo-elements, and `box-sizing` is not normally inherited. Scope limits
selector matching; an explicit `inherit` still reads the DOM parent's value.

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

Converted components use `<style scoped>`. `:host` and `:host-state()` become attribute selectors
on the generated root; Vue's own `:slotted()` handles projected content.

## Proof

`tests/platform-scoping.test.ts` checks the platform behavior this relies on in Chromium, Firefox,
and WebKit.
