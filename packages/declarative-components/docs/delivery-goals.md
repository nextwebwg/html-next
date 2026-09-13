# Delivery goals

Declarative Components has three delivery products over one language. This ledger keeps their
completion criteria, measurements, and next evidence separate.

## Complete live browser distributable

**Current work.** Minimize the full-capability browser entry by composing Web Platform facilities
and removing universally redundant runtime machinery.

- Contract: [live browser distributable](spec/live-browser-distributable.md)
- Input boundary: any conforming component graph introduced during the document lifetime
- Current baseline: 103,125 minified raw bytes and 33,199 gzip bytes
- Current result: 102,017 minified raw bytes and 33,004 gzip bytes
- Primary metric: production gzip for the public browser-loader entry
- Required evidence: complete-capability assertion, module attribution, cross-browser conformance,
  and representative runtime measurements
- Current audit: [native runtime audit](native-runtime-audit.md)
- Completion: every live subsystem has a current native-first disposition, the complete artifact is
  smaller than the baseline, performance guardrails pass, and no known universally redundant layer
  remains

Measurement output now separates this complete live product from native-build capability
attribution. All 24 contributing modules are classified into seven audited responsibilities, and a
new unclassified dependency fails the gate. Next work runs measured parser, execution, lifecycle,
compatibility, and policy reductions against this complete entry.

## Native application or library build

**Tracked goal.** Compile a complete application or library graph to native DOM with one
graph-scoped support plan.

- Contract: [native application or library build](spec/native-application-build.md)
- Input boundary: application entries or a concrete public library entry set
- Primary metrics: whole application output; full library output; representative consumer subsets
- Attribution metrics: isolated capability fixtures, reported separately from product output
- Current evidence: static, basic-reactive, computed, and scalar-prop fixtures avoid the live parser
  and general runtime; keyed lists, declared reads, enhanced forms, and controller lifecycle still
  enter the general fallback
- Completion: graph capability union, shared support emission, application and library packaging,
  dynamic-boundary behavior, hydration, and live/native conformance all satisfy the delivery spec

The next implementation milestone replaces per-fixture reasoning with graph-wide capability
analysis and shared host generation.

## Framework conversion

**Tracked goal.** Convert application and library graphs into React, Vue, and Svelte components that
use target-native rendering, reactivity, lifecycle, lists, and hydration.

- Contract: [framework conversion](spec/framework-conversion.md)
- Input boundary: application or library entries plus a target framework and supported version
- Primary metrics: generated output, HTML Next bridge cost, target framework/runtime cost, and total
  production output
- Required evidence: cross-target observable conformance, SSR/hydration identity, controller-host
  parity, request cleanup, and representative consumer bundles
- Current evidence: target generators and conformance fixtures exist; adapters that import the
  general component runtime remain implementation evidence rather than the completed target-native
  architecture
- Completion: all supported capabilities map to target-native primitives or measured semantic
  bridges, and application and library outputs satisfy the framework conversion spec

The next implementation milestone defines the common conversion plan, audits each target adapter's
general-runtime imports, and moves shared cases onto target-native facilities.

## Measurement rule

Every reported number names one of these goals, the input graph, included capabilities, browser or
framework versions, and the measured bundle boundary. A reduction advances only the goal whose
delivery assumptions produced it.
