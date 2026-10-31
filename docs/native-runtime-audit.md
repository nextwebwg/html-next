# Value format runtime audit

This records the browser mechanisms considered for the [Declarative Components type proposal](https://nextwebwg.org/declarative-components/types). It describes implementation choices, not the specification.

On 2026-09-29, detached inputs were probed in Chromium, Firefox, and WebKit by setting `type` and `value`, then reading the sanitized value and `ValidityState`. All three accepted `a@b` for `type=email`, rejected `a@-b`, accepted an absolute `https:` URL, and rejected a relative URL for `type=url`. The HTML Standard defines the [email address production](https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address) and the [URL state's validity rules](https://html.spec.whatwg.org/multipage/input.html#url-state-(type=url)). The email fallback now uses HTML's published regular expression, including single-label domains.

Native date, month, week, time, and local date-time inputs are useful format probes, but `validity.valid` alone does not establish format validity. Invalid date values were sanitized to empty. A valid time with fractional seconds retained its value but failed the default minute step. Firefox retained `2026-13` in a month input while the other two engines cleared it. The type parser therefore checks the [HTML date and time microsyntaxes](https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#dates) directly and keeps the original string; it does not use form-control step validation for a prop.

For CSS `color`, browsers provide `CSS.supports`, but Node builds and server rendering have no equivalent browser CSS parser. The initial type accepts the same bounded set of named, hex, and numeric function literals in both environments. This avoids a value passing in the browser and failing during server rendering. CSS `color-mix()` and relative color syntax are outside this initial set. The [proposal's type table](https://nextwebwg.org/declarative-components/types) names the supported forms. A broader color grammar needs a parser usable in both environments and representative parity tests before it is added.

## Shared component stylesheets

On 2026-10-08, Chromium 153, Firefox 155, and WebKit 26.6 retained `CSSImportRule` in a style element inside `document.implementation.createHTMLDocument()`, exposing the URL, layer, supports condition, and media list without requesting imported resources. Constructed stylesheet replacement discards imports. The live loader therefore uses an inert document to parse CSS, fetches the import graph under the component resource policy, and passes resolved bodies to the existing CSSOM selector compiler. Node tools use their existing PostCSS parser. Browser URL resolution, CSS parsing, and `@scope` provide the native mechanisms; dependency fetching, URL rebasing, adoption tracking, and shared delivery are the remaining tooling gap.

Direct `box-sizing` rules respect nested-component and projected-content scope limits; inheritance still follows the DOM. A selector list combining universal and pseudo-element selectors exposed a Firefox 155 scope-limit defect: a projected element received the regular element's box-sizing rule. A zero-specificity boundary guard on affected own selectors prevents the leak while retaining the scope root. The guard belongs in the compiler rather than application defaults.

Firefox also retained the previous root's scoped host style during dynamic root replacement. A zero-specificity owner qualifier on the rewritten host selector prevents that stale match. Firefox's HTML preload scanner can fetch imports from authored template source before the loader starts; the loader's inert CSS parser does not initiate those requests.


## Stylesheet namespaces

On 2026-10-08, Chromium 153, Firefox 155, and WebKit 26.6 parsed `CSSNamespaceRule` in
constructed stylesheets and accepted namespace-qualified `CSSStyleRule.selectorText` updates.
All three rejected removing a namespace declaration while dependent style rules remained.
The compiler therefore leaves declarations in each parsed sheet while pruning and rewriting
rules, and moves their serialized declarations into the delivered stylesheet's preamble.

Namespace prefixes and defaults are local to each stylesheet under
[CSS Namespaces](https://www.w3.org/TR/css-namespaces-3/). Combining sheets needs a source
transform: stable URI-derived named prefixes, explicit default namespace constraints, and
rewrites of selector-valued functions and scope/supports preludes. CSSOM owns browser parsing;
PostCSS owns build parsing. Unprefixed attributes keep their ordinary no-namespace behavior.
The subject compound inside `:is()`, `:where()`, and `:not()` follows the default-namespace
exception in [Selectors Level 4](https://www.w3.org/TR/selectors-4/).

A reduced standalone SVG test exposes a Firefox 155 scope-limit defect even without
namespaces: both an owned rect and a rect below an excluded SVG receive a scoped class rule.
Chromium and WebKit style only the owned rect. The reproduction is checked in at
`packages/html-next/tests/fixtures/firefox-svg-scope.html` and filed as
[Mozilla bug 2080046](https://bugzilla.mozilla.org/show_bug.cgi?id=2080046). This observation
uses Playwright's Firefox build; a stock release/Nightly reproduction remains unverified.


## Firefox SVG scope workaround

On 2026-10-08, changing only an unused inherited custom property on a boundary prevented
Firefox 155 from applying the native fixture's scoped SVG class rule below that boundary.
The same result holds for conflicting namespaces, nested and empty components, explicit
slotted rules, layered sheets, resolved host states and DOM moves. This supports incorrect
style reuse as the cause; Firefox's internal cache behavior has not been traced in source.

The compiler supplies an inherited `--html-next-scope-owner` identity using existing
`data-component` and projection selectors. A normal reset marks nested boundaries, while
important private declarations identify roots and projection regions independently of author
layers. Direct declarations at a child boundary replace inheritance from a parent even when
the parent's private value is important. The rules run only under the Firefox-specific
`@supports (-moz-appearance: none)` query. Author fill, typography, custom properties and
other inherited values retain ordinary CSS behavior.

The live loader installs one common reset independent of application-owned sheets; a closed
graph includes one reset outside authored import conditions. Hybrid delivery retains the live
reset even when a precompiled sheet also includes one, because that sheet can be conditioned
or disabled independently.

Definition-specific root identities stay with their compiled CSS. Native CSS
matching and inheritance handle insertion, movement and removal. Vue's scope attributes and
Svelte's hash class distinguish owned and projected nodes. No new observer or element ownership
marker is introduced.

A sequential local Playwright Firefox stress probe used 50 definitions, 1,000 component roots
and 24,000 SVG rects. Across 20 measured alternating samples, initial DOM insertion plus forced
style reads had medians of 24 ms without the workaround and 27 ms with its shared rules
(1.125×); class updates plus style reads were 9 ms in both cases. These synthetic observations
are a cost check, not a general application benchmark. Repeated copies of the common rules
cost more, so live and graph delivery keep only one copy. The browser fixture, loader parity,
SSR graph comparison and build/Svelte boundary cases provide the independent regression checks.


## Preact conversion

On 2026-10-31, the Preact adapter was added using the existing React lowering and feature
helpers, rebound to `preact/compat` and Preact JSX. Native DOM events, form validity and
control defaults remain owned by the existing shared helpers; Preact owns rendering,
observation through hooks, scheduling, ref cleanup and hydration. The remaining gaps are
build-time import/type adaptation and native attribute serialization. Preact's DOM renderer
looks up property names case-sensitively, while HTML attribute names are case-insensitive.
The compiler emits uppercase `VALUE` for generic value attributes and `CONSTRUCTOR` for
that unreflected attribute, allowing the browser to apply attributes without invoking a
different DOM property setter. SVG retains its case-sensitive names. Enumerated booleans
are strings in server output. Native control helpers own authored reset defaults; the
Preact memoized input wrapper keeps its initial default. Bound selects use
Preact's core element factory and supply the initial selection once, so its compatibility
layer does not rewrite option selection when surrounding state changes. Preact 11 is required
because generated components receive refs as props; see its
[upgrade guide](https://preactjs.com/guide/v11/upgrade-guide/#refs-are-forwarded-by-default).


## Angular conversion

Angular attribute-selected standalone components retain the authored native host. Native attributes, properties, events, focus, form validation and CSS scopes continue to belong to that element; Angular signals and template control flow own updates. Angular selector matching is static and permits one component per element. A component-root chain therefore needs compile-time composition of its scopes and template into one Angular component. Host attributes retain each component identity for CSS without activating additional Angular components. Generated selectors use the same native style compiler with identity selectors mapped to component attributes; Angular view encapsulation is disabled because the converter already establishes CSS boundaries. No shadow root or browser parser/interpreter is introduced.

Angular content projection can insert consumer-authored nodes without a converter hook at insertion. Generated own markup carries an ownership attribute; a feature-specific projection directive marks foreign projected roots for the existing native CSS scoping rules. It stamps after Angular view creation (also during SSR) and uses a native MutationObserver for later child-list changes. A generic data-hn root boundary, shared with the other framework outputs, keeps scopes bounded by separately converted libraries whose component names are unknown at generation time. Component identity itself remains the authored tag attribute.

Separately converted source libraries share Angular context-token identities through a Symbol.for registry on the current global object. The registry holds tokens only; Angular injectors and signals continue to own provider scope and state. Native control setters, default restoration and pre-hydration snapshots reuse the existing target-independent control module through an Angular directive.

Angular pipes own per-view retention of accepted expression output, including keyed loop views. Host bindings retain their value on the generated component instance. Angular computed signals own computed caching; the shared input-observation protocol supplies readiness when a state initializer reads a prop. Browser module and controller hosts use the existing shared native connection observer, activation cancellation, controller namespaces and input-port protocol. Angular signals, computed values, effects and injector-scoped disposal own their reactive work.

Sanitized markup has no Angular child views. Its helper composes the existing sanitizer and parse5 policy with Renderer2 node creation instead of assigning innerHTML, which would reparse table fragments in a different element context. Matching server-rendered markup is compared before mutation so hydration retains node identity and native selection. Inline fragment markup and authored Angular child views inside a raw-markup region need a separate ownership decision and remain explicit conversion diagnostics. Data reads use Angular effects, a shared native connection observer, fetch and AbortController; sampled parameters are read outside dependency tracking, while live parameter keys trigger cancellation and replacement.

Scoped slots use Angular's `TemplateRef`, content queries, `NgTemplateOutlet`, and template context guards. The compiler composes delegated slot content and emits typed directives for external templates. Each embedded view owns independent retained slot values. Native `CustomEvent` dispatch stays on the host; exported event maps supply consumer payload types. Binding declared events through the native listener avoids duplicate delivery from an Angular output of the same name. The shared document-head manager uses core DOM mutations and falls back from an unimplemented server `baseURI` getter to the document URL and authored base element. Declared-script preload ownership survives later head reconciliation. Those interoperability changes add 78–79 B gzip to the component-identity baseline for the existing head fixtures, with no interpreter added to generated bundles.

## Rendered component identity

On 2026-10-31, the rendered identity contract selected `component` as canonical output with a
`data-component` polyfill fallback. DOM attribute reads distinguish an absent attribute from an
empty value; nullish fallback preserves canonical precedence. Native selector matching, `:is`,
`:not` and `@scope` express the same precedence for styles and boundaries. Definition carriers
remain `template[component]`, so root discovery excludes them. No additional observer or attribute
mirroring is needed. Hydration reads either spelling in place; serialization normalizes only its
cloned output. Cross-browser scoped-style coverage checks both spellings, conflicting values,
empty canonical values and fallback after removing the canonical attribute.

Framework style conversion normalizes canonical and legacy identity selectors in one shared build stage. React and Preact emit canonical `component` selectors; Vue and Svelte use their component classes; Angular uses native host attributes. The shared stage handles imported sheets, scope boundaries, namespace prefixes and authored identity selectors while preserving quoted values.
