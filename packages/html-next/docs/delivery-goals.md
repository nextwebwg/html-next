# Delivery goals

Declarative Components has three delivery products over one language. This ledger keeps their
completion criteria, measurements, and next evidence separate.

## Complete live browser distributable

**Current work.** Minimize the full-capability browser entry by composing Web Platform facilities
and removing universally redundant runtime machinery.

- Contract: [live browser distributable](https://nextwebwg.org/declarative-components/)
- Input boundary: any conforming component graph introduced during the document lifetime
- Current baseline: 103,125 minified raw bytes and 33,199 gzip bytes
- Current result: 76,223 minified raw bytes and 25,854 gzip bytes
- Primary metrics: reactive-matrix execution time and production-minified bytes for the public
  browser entry; gzip remains a reported transport metric
- Required evidence: complete-capability assertion, module attribution, cross-browser conformance,
  and representative runtime measurements
- Current audit: [native runtime audit](native-runtime-audit.md)
- Completion: every live subsystem has a current native-first disposition, the complete artifact is
  smaller than the baseline, performance guardrails pass, and no known universally redundant layer
  remains

Measurement output now separates this complete live product from native-build capability
attribution. All 20 contributing modules are classified into six audited responsibilities, and a
new unclassified dependency fails the gate. Next work runs measured parser, execution, lifecycle,
compatibility, and policy reductions against this complete entry.

The general runtime also has a [Node rendering entry](server-rendering.md). Its
Node-to-browser tests cover instance restoration and subsequent updates in Chromium, Firefox and
WebKit, including declared state, explicit props, slots, shared context, keyed rows and native
control edits. This is separate evidence from specialized native factories and converter hydration;
the incomplete hydration milestones below refer to those delivery products.

## Native application or library build

**Tracked goal.** Compile a complete application or library graph to native DOM with one
graph-scoped support plan.

- Contract: [native application or library build](https://nextwebwg.org/declarative-components/)
- Input boundary: application entries or a concrete public library entry set
- Primary metrics: whole application output; full library output; representative consumer subsets
- Attribution metrics: isolated capability fixtures, reported separately from product output
- Current evidence: the build plugin analyzes the linked component graph, emits one graph-scoped
  support module, and exposes distinct application and library entry contracts. Empty static child
  invocations compile to linked factories; unsupported invocation edges, cycles, and undeclared
  boundaries fail with source-located diagnostics. Keyed lists, declared reads, controller
  lifecycle, child inputs and projection, physical library artifacts, and hydration parity remain
  incomplete.
- Completion: graph capability union, shared support emission, application and library packaging,
  dynamic-boundary behavior, hydration, and live/native conformance all satisfy the delivery spec

The next implementation milestone expands linked factory calls beyond empty static invocations,
then turns the stable virtual library entries into publishable files with declarations and export
metadata.

## Framework conversion

**Tracked goal.** Convert application and library graphs into Vue, React, Preact, Svelte, and Angular
components that use the target's rendering, reactivity, lifecycle, lists, and hydration.

- Contract: [converter requirements](../../html-next-converter/docs/requirements.md)
- Input boundary: application or library entries plus a target framework and supported version
- Primary metrics: generated output, HTML Next bridge cost, framework/runtime cost, and total
  production output
- Required evidence: cross-target appearance and behavior, SSR and hydration, controller lifecycle,
  request cleanup, public types, and independently installed consumer bundles
- Completion: every supported capability maps to target primitives or a measured semantic bridge;
  every target converts the complete pinned Looma catalog, compiles with its framework toolchain,
  and passes the same complete renderer-independent browser and SSR tests. Required HTML Next
  checks must also pass on the final changes.

`pnpm test:targets` runs the focused feature fixtures and the public converter conformance corpus.
The public corpus uses the shared HTML Next cases and expected results in both delivery modes,
compares behavior and exact pixels in Chromium, Firefox, and WebKit, and repeats the checks through
SSR, hydration, and interactions. Framework ownership and styling metadata may differ; portable
content and behavior must agree.

`pnpm verify:converters` builds the SDK, prepares the pinned Looma catalog for native HTML Next and
all five frameworks, and runs its shared tests plus HTML Next's target fixtures. CI shards the
catalog and feature tests to keep each check within the repository's time limit. The separate
Converter corpus workflow runs the broad shared-case sweep. Qualification records must identify
both source revisions and every required run; a successful focused fixture alone does not complete
this goal.

## Measurement rule

Every reported number names one of these goals, the input graph, included capabilities, browser or
framework versions, and the measured bundle boundary. A reduction advances only the goal whose
delivery assumptions produced it.
