# Runtime performance guardrails

The reference runtime aims to add as little JavaScript and DOM work as each authored feature
requires. Native platform behavior is the first implementation candidate because it often removes
code and preserves browser semantics. It is not automatically the fastest or smallest composition.
The [native runtime audit](./native-runtime-audit.md) records each browser primitive, remaining
library layer, measurement, and owner decision.

## Evidence required

Runtime changes report these dimensions together:

- minified and gzip bundle deltas for every affected generated fixture and the live loader;
- absolute time and relative change for the affected operation in a representative workload;
- DOM operations or allocations when they explain the result; and
- behavior across Chromium, Firefox, and WebKit when a browser algorithm is involved.

Ratios do not stand alone. A change from 0.05 to 4 microseconds and a change from 5 to 400
milliseconds are both 80 times slower, but have different user impact. Absolute cost also does not
stand alone when an operation can run for every input event, list row, or DOM mutation.

## Decision thresholds

Correctness, accessibility, security, and interoperability are hard gates. Among conforming
implementations:

- Treat changes below 5% as measurement noise unless repeated samples demonstrate otherwise.
- Reject a change that makes a representative hot path more than 25% slower while saving less
  than both 1 KB gzip and 5% of the affected bundle.
- A greater than 2x hot-path regression needs a unique correctness or interoperability benefit and
  explicit owner review, even when the absolute operation remains short.
- Added bytes can be justified by a measured reduction in expensive browser work. Keyed-list
  reconciliation, for example, may spend a small amount of JavaScript to avoid hundreds of DOM
  moves.
- When native runtime delegation loses this comparison, use native behavior as the conformance
  oracle in cross-browser tests and keep the smaller or faster equivalent implementation.

These are rejection and review thresholds, not automatic acceptance rules. Results must use the
same fixture, browser, build settings, warm-up, and sampling method. A user-facing workload takes
precedence over an isolated microbenchmark; the microbenchmark remains useful for attributing its
cost.

## Current size gates

`pnpm measure:runtime` reports two named delivery products. `live_distributable` bundles the
public browser-loader entry for an open graph, records its raw and gzip size, attributes its module
inputs, and asserts that every implemented live capability remains reachable. It also rejects
server-side parser and generated DOM-inventory modules.

`native_build.capabilityFixtures` attributes isolated generated features. Static output must
remain at or below 2.5 KB gzip. Basic reactive, numeric-computed, and scalar-prop output must remain
at or below 5 KB gzip. Fixtures without a settled budget remain visible so a general-runtime
fallback is measured before a graph-wide native implementation is designed. These capability
fixtures do not stand in for the complete live distributable or a whole application/library build.

The settled limits and complete-live assertion fail `verify:inner`; they are release gates rather
than informational targets. The optimizer uses `--profile=live-distributable` to obtain the same
complete live result as a flat metric record without measuring a different bundle.

`pnpm measure:hydration` separately measures compatible server-DOM adoption and fresh lowering in
Chromium, Firefox, and WebKit. Every sample also asserts that adoption preserves root and input
identity, a live user edit, focus, and selection. The report includes total and per-root median and
p95 timings; it is a local comparison baseline rather than a fixed CI latency gate.
