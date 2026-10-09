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
matching and inheritance handle insertion, movement and removal. Svelte's existing ownership
selectors mark its projection regions; Vue's built-in scoped selectors already distinguish
owned and projected nodes. No new observer or element ownership marker is introduced.

A sequential local Playwright Firefox stress probe used 50 definitions, 1,000 component roots
and 24,000 SVG rects. Across 20 measured alternating samples, initial DOM insertion plus forced
style reads had medians of 24 ms without the workaround and 27 ms with its shared rules
(1.125×); class updates plus style reads were 9 ms in both cases. These synthetic observations
are a cost check, not a general application benchmark. Repeated copies of the common rules
cost more, so live and graph delivery keep only one copy. The browser fixture, loader parity,
SSR graph comparison and build/Svelte boundary cases provide the independent regression checks.
