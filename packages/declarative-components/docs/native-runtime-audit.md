# Native runtime audit

The browser runtime composes Web Platform facilities into the behavior defined by Declarative HTML
Components. This ledger identifies the platform foundation for each subsystem, the code that still
belongs to the reference implementation, and the evidence or decision required to keep it.

The current live-loader attribution comes from `pnpm measure:runtime`. Values are minified raw bytes
inside the 103,125-byte bundle; gzip is reported for whole fixtures because compressed bytes cannot
be attributed cleanly to individual modules. `pnpm audit:native` records relevant platform surface
support and the native sanitizer's output in the installed Chromium, Firefox, and WebKit builds.

| Subsystem | Platform foundation | Reference-library layer | Current evidence and status |
| --- | --- | --- | --- |
| Component HTML parsing | `<template>`, the HTML parser, DOM traversal, native element/property introspection | Proposal grammar, declarations, diagnostics, and contract construction | Browser bundles contain zero `parse5` and zero generated DOM-property inventory modules. `parser.ts` contributes 16,302 raw bytes to the full live compiler and zero bytes to directly generated components. Retained for live authoring; continue compiling it out of generated output. |
| Component discovery and lifecycle | `MutationObserver`, selector matching, `Node.isConnected`, native `connect`/`disconnect` events | One realm-global document subscriber hub and one component lifecycle coordinator | Owner-approved shape: added scopes are queried once against the registered tag selector; removed scopes are queried only for marked component roots. Connected instances own their cleanup and reconnect work. |
| Reactive scheduling | Native events, property access, `queueMicrotask()` | Dependency collection for proposal state, computed values, and effects | `reactivity.ts` contributes 2,794 raw live-loader bytes. Static, numeric state, numeric computed, and scalar-prop generated components compile this layer away. Retention for dynamic live expressions remains pending owner review. |
| Expressions | JavaScript primitives and native string/number operations | CSP-safe parser, typed operations, missing-value semantics, dependency paths, and diagnostics | `expression.ts` contributes 7,075 raw live-loader bytes. Generated output emits only expressions whose semantics it can prove; all other shapes retain the interpreter. Retention for the live authoring path remains pending owner review. |
| Public props | Element properties, attributes, `MutationObserver`, native scalar conversion | Declared type boundary, reflection batching, and property-only values | Direct scalar and enum props produce a 1,696-byte gzip fixture. Complex prop codecs still pull the full runtime and are an active generated-output target. |
| Keyed lists | `Map`, comment range markers, `ParentNode.moveBefore()` where implemented, and `insertBefore()` compatibility | Duplicate-key diagnostics and a longest-increasing-subsequence choice of which blocks to move | Owner approved the LIS layer for keyed `$each`. A distant 1,000-row swap moves two blocks instead of roughly 1,000. Chromium and Firefox use state-preserving `moveBefore()`; WebKit currently uses `insertBefore()`. |
| Declared reads | `fetch()`, `URL`, `URLSearchParams`, `AbortController`, response body readers, and timers | Parameter dependency updates, debounce/poll policy, stale-result suppression, state projection, and declared response validation | `data.ts` contributes 2,358 raw live-loader bytes before its type/schema dependencies. The generated data fixture is 22,868 bytes gzip. A feature-specific generated path and the remaining orchestration contract require owner review. |
| Enhanced forms | Native `<form>`, successful controls via `FormData`, `SubmitEvent.submitter`, native constraint validation, URL encoding, `fetch()`, and `AbortController` | Opt-in fetch enhancement, declared parameters, pending/result state, and success/error events | The implementation lives in the independent `@nextwebwg/html-forms` package. The generated form fixture is 23,038 bytes gzip because component output still enters the general runtime. Generated integration is an active size target; form semantics remain owned by the separate proposal. |
| Validity | Native controls and `ValidityState` | Equivalent generalized-element validity and extension errors | Native controls always use browser validity. The pure generalized validator is checked against controls in Chromium, Firefox, and WebKit. Cached detached-control delegation was rejected: 168 gzip bytes saved did not justify an approximately 80x numeric microbenchmark regression. Owner approved the measured guardrail. |
| Dynamic HTML content | `<template>` fragment parsing, DOM traversal, Trusted Types-compatible sinks | Allow/block policy for `$html` content | Owner-approved for the current baseline: retain the 696-byte minified raw `sanitize.ts` implementation across engines. Standard `setHTML()` exists in the tested Chromium and Firefox builds but not WebKit. Its safe default also removes the fixture's ordinary image and form, which the current policy preserves. Revisit when every target engine exposes equivalent policy control. |
| Component styling | CSS parser/CSSOM, selectors, cascade, native style elements | Build-time scoping and live-source selector transformation, including generalized validity compatibility | `style.ts` contributes 5,485 raw live-loader bytes; generated CSS pays no browser-runtime parser cost. Native `@scope` and the remaining compatibility transformations need a separate parity and size experiment before a retention decision. |
| Controllers | Native ESM, `EventTarget`, selectors, form collections, and cleanup callbacks | The `ComponentHost` state/effect facade and lifecycle attachment | Controller modules load through native `import()`. A controller-only generated fixture still costs 22,772 bytes gzip because it receives the general host. A smaller host subset would be new custom glue and therefore requires owner agreement before implementation. |
| Resource graphs and import maps | `URL`, `fetch()`, native module loading, and application import-map markup | HTML component dependency graph, trust-root enforcement, redirect checks, and import-map snapshot resolution | `graph.ts`, `resolve.ts`, `browser-source.ts`, and `browser-loader.ts` contribute 7,346 raw live-loader bytes together. Browsers apply import maps to modules but expose no equivalent general component-resource resolver. Retention of the trust and graph policy remains pending owner review. |
| Hydration and adoption | Existing DOM identity, selectors, control state, focus, and selection APIs | Matching server-lowered roots to definitions and attaching only authored behavior | Cross-browser tests preserve node identity and live form-control state. `pnpm measure:hydration` reports server-DOM adoption and fresh lowering separately while asserting identity, edit, focus, and selection preservation on every sample. |

## Measured generated paths

| Authored feature | Gzip bytes | Runtime shape |
| --- | ---: | --- |
| Static markup | 302 | Direct DOM creation |
| Numeric state and handler | 412 | Direct variables, native event, microtask update |
| Numeric computed state | 419 | Direct arithmetic in the same update |
| Scalar and enum props | 1,696 | Generated prop boundary and shared lifecycle helper |
| Keyed list | 22,967 | Full-runtime fallback |
| Declared read | 22,868 | Full-runtime fallback |
| Enhanced form | 23,038 | Full-runtime fallback |
| Controller lifecycle | 22,772 | Full-runtime fallback |

The first four paths have hard size gates. The remaining fixtures make fallback costs visible while
their feature-specific implementations and budgets are evaluated.

## Review sequence

The next decisions are intentionally separated so approval of one custom layer cannot be read as
approval of all runtime machinery:

1. Controller host: define the smallest host contract generated controller-only components may
   receive without importing the full reactive runtime.
2. Declared reads: distinguish request behavior supplied directly by Fetch/URL/AbortController from
   proposal state and scheduling that generated output must retain.
3. Styling: test native `@scope` against current selector, `:host`, nesting, and validity behavior.
4. Live expressions and dependency tracking: quantify the irreducible live-authoring layer after
   generated paths have removed it from production components.
5. Resource graphs: review the security/trust behavior separately from URL and import-map parsing.
