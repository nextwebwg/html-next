# Native runtime audit

The browser runtime composes Web Platform facilities into the behavior defined by Declarative HTML
Components. This ledger identifies the platform foundation for each subsystem, the code that still
belongs to the reference implementation, and the evidence or decision required to keep it. The live
distributable supports arbitrary dynamic component graphs. Native builds analyze a complete
application or library graph and share the support required by that graph. Framework converters use
their target runtime for equivalent behavior.

The current live-loader attribution comes from `pnpm measure:runtime` under
`live_distributable`. Values are minified raw bytes inside the current 95,580-byte bundle; its
complete gzip size is 31,415 bytes, down from the 33,199-byte baseline. Compressed bytes cannot be
attributed cleanly to individual modules.
The `native_build.capabilityFixtures` group reports isolated generated attribution.
`pnpm audit:native` records relevant platform surface support and the native sanitizer's output in
the installed Chromium, Firefox, and WebKit builds.

## Complete live inventory

The production browser entry currently contains 95,444 attributed minified raw bytes plus 136
bytes of bundler framing. Every contributing module belongs to one audited responsibility; an
unclassified dependency fails `measure:runtime`.

| Responsibility | Minified raw bytes | Native foundation under review |
| --- | ---: | --- |
| Reactive execution | 36,657 | DOM identity and updates, events, microtasks, connection state, Fetch, cancellation, native ESM |
| Types and validation | 26,157 | Native control validity, Web IDL conversion, platform value objects |
| Parsing and contract | 20,330 | Browser-parsed inert DOM, attributes, template contents, element/property reflection |
| Style and content policy | 6,181 | CSSOM, `@scope`, template parsing, safe HTML sinks |
| Component resources | 3,958 | URL, Fetch, import maps, native ESM, CORS, CSP |
| Discovery and lifecycle | 2,161 | Shared MutationObserver, selector matching, node identity, connection state |

These groups are cost attribution, not separately shipped runtimes. The complete live distributable
contains all of them for arbitrary later graphs.

| Subsystem | Platform foundation | Reference-library layer | Current evidence and status |
| --- | --- | --- | --- |
| Component HTML parsing | `<template>`, the HTML parser, DOM traversal, native element/property introspection | Proposal grammar, declarations, diagnostics, and contract construction | The live parser reads the browser's inert DOM directly instead of cloning a parse5-shaped tree. Shared parsing owns definition safety, so live mounting avoids a second recursive safety traversal. Attribute reads use `getAttribute()` and traverse the browser's `NamedNodeMap`; traversal-only child passes iterate native `NodeList` objects. A 200-element attribute-read/scan microbenchmark measured the native path at 3.8x in Chromium, 3.9x in Firefox, and 4.1x in WebKit; source-adapter parity passes all three engines. These parser cuts remove 534 raw and 101 gzip bytes from the complete baseline while browser bundles contain zero `parse5` and zero generated DOM-property inventory modules. |
| Component discovery and lifecycle | `MutationObserver`, selector matching, `Node.isConnected`, native `connect`/`disconnect` events | One realm-global document subscriber hub and one component lifecycle coordinator | Owner-approved shape: definition changes update one cached tag selector; added scopes are queried against it, and matching elements resolve through the registry map. Mutation batches allocate work only for actual matches instead of every registered component. Removed scopes are queried only for marked component roots, and connected instances own their cleanup and reconnect work. Definitions retain only runtime-consumed data. |
| Reactive scheduling | Native events, property access, `queueMicrotask()` | Dependency collection for proposal state, computed values, and effects | `reactivity.ts` contributes 2,832 raw live-loader bytes. Static, numeric state, numeric computed, and scalar-prop generated components compile this layer away. Retention for dynamic live expressions remains pending owner review. |
| Expressions | JavaScript primitives and native string/number operations | CSP-safe parser, typed operations, missing-value semantics, dependency paths, and diagnostics | `expression.ts` contributes 6,701 raw live-loader bytes. Its direct regex/precedence parser eliminates token arrays and improves the measured unique-compile and compiled-evaluation workloads while preserving the public AST. Generated output emits only expressions whose semantics it can prove; all other shapes retain the interpreter. |
| Public props | Element properties, attributes, `MutationObserver`, native scalar conversion | Declared type boundary, reflection batching, and property-only values | Direct scalar and enum props produce a 1,715-byte gzip fixture. The contract and type boundary share one recursive-freeze implementation. Complex prop codecs still pull the full runtime and are an active generated-output target. |
| Keyed lists | `Map`, comment range markers, `ParentNode.moveBefore()` where implemented, and `insertBefore()` compatibility | Duplicate-key diagnostics and a longest-increasing-subsequence choice of which blocks to move | Owner approved the LIS layer for keyed `$each`. A distant 1,000-row swap moves two blocks instead of roughly 1,000. Chromium and Firefox use state-preserving `moveBefore()`; WebKit currently uses `insertBefore()`. |
| Declared reads | `fetch()`, `URL`, `URLSearchParams`, `AbortController`, response body readers, and timers | Parameter dependency updates, debounce/poll policy, stale-result suppression, state projection, and declared response validation | `data.ts` contributes 2,358 raw live-loader bytes before its type/schema dependencies. The isolated build fixture is 22,198 bytes gzip. A build-scoped compiled implementation and the remaining orchestration contract require owner review. |
| Native form participation | Native `<form>`, form ownership, successful controls, constraint validation, and submission | Preserve component-rendered controls as ordinary DOM controls | Request enhancement is independently available from `@nextwebwg/html-forms`; Declarative Components does not import or re-export it. |
| Validity | Native controls and `ValidityState` | Equivalent generalized-element validity and extension errors | Native controls always use browser validity. The pure generalized validator is checked against controls in Chromium, Firefox, and WebKit. Cached detached-control delegation was rejected: 168 gzip bytes saved did not justify an approximately 80x numeric microbenchmark regression. Owner approved the measured guardrail. |
| Dynamic HTML content | `<template>` fragment parsing, DOM traversal, Trusted Types-compatible sinks | Allow/block policy for `$html` content | Owner-approved for the current baseline: retain the 696-byte minified raw `sanitize.ts` implementation across engines. Definition validation now imports this module's URL-attribute and executable-scheme policy instead of carrying a second copy. Standard `setHTML()` exists in the tested Chromium and Firefox builds but not WebKit. Its safe default also removes the fixture's ordinary image and form, which the current policy preserves. Revisit when every target engine exposes equivalent policy control. |
| Component styling | CSS parser/CSSOM, selectors, cascade, native style elements | Build-time scoping and live-source selector transformation, including generalized validity compatibility | `style.ts` contributes 5,485 raw live-loader bytes; generated CSS pays no browser-runtime parser cost. Native `@scope` and the remaining compatibility transformations need a separate parity and size experiment before a retention decision. |
| Controllers | Native ESM, `EventTarget`, selectors, form collections, and cleanup callbacks | The uniform `ComponentHost` state/effect facade and lifecycle attachment | Controller modules load through native `import()`. The isolated controller capability fixture costs 22,102 bytes gzip because the native build includes the general runtime. The intended build shape is one graph-scoped host implementation shared by the application or library output. It keeps the full controller-facing contract while pruning implementation machinery the graph does not require. |
| Resource graphs and import maps | `URL`, `fetch()`, native module loading, and application import-map markup | HTML component dependency graph, trust-root enforcement, redirect checks, and import-map snapshot resolution | `graph.ts`, `resolve.ts`, `browser-source.ts`, and `browser-loader.ts` contribute 6,953 raw live-loader bytes together. Browsers apply import maps to modules but expose no equivalent general component-resource resolver. Retention of the trust and graph policy remains pending owner review. |
| Hydration and adoption | Existing DOM identity, selectors, control state, focus, and selection APIs | Matching server-lowered roots to definitions and attaching only authored behavior | Cross-browser tests preserve node identity and live form-control state. `pnpm measure:hydration` reports server-DOM adoption and fresh lowering separately while asserting identity, edit, focus, and selection preservation on every sample. |

## Native-build capability fixtures

| Authored feature | Gzip bytes | Runtime shape |
| --- | ---: | --- |
| Static markup | 302 | Direct DOM creation |
| Numeric state and handler | 412 | Direct variables, native event, microtask update |
| Numeric computed state | 419 | Direct arithmetic in the same update |
| Scalar and enum props | 1,715 | Generated prop boundary and shared lifecycle helper |
| Keyed list | 22,327 | Full-runtime fallback |
| Declared read | 22,231 | Full-runtime fallback |
| Controller lifecycle | 22,132 | Full-runtime fallback |

The fixtures isolate authored capabilities so regressions and fallback costs remain attributable.
They are not separate per-component runtimes. An application or library build combines the complete
input graph, deduplicates shared support, and emits one coherent native target. The first four
fixtures have hard size gates. The remaining fixtures expose current full-runtime fallbacks while
their build-scoped implementations and budgets are evaluated.

## Review sequence

The next decisions are intentionally separated so approval of one custom layer cannot be read as
approval of all runtime machinery:

1. Native build host: preserve the uniform controller contract while deriving one shared host
   implementation from the capabilities used across the application or library graph.
2. Declared reads: distinguish request behavior supplied directly by Fetch/URL/AbortController from
   proposal state and scheduling that generated output must retain.
3. Styling: test native `@scope` against current selector, `:host`, nesting, and validity behavior.
4. Live expressions and dependency tracking: quantify the irreducible live-authoring layer after
   generated paths have removed it from production components.
5. Resource graphs: review the security/trust behavior separately from URL and import-map parsing.
