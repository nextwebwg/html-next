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

- Calibrate candidate results against independent whole-set A/A runs. When the observed difference
  cannot be distinguished from that run-to-run variance, record it as inconclusive and keep the
  candidate available for a quieter measurement; uncertainty is not a rejection.
- Keep a repeatable improvement even when it is small when tests are stable, no workload has an
  established regression, and the implementation does not add significant code or bundle size.
  There is no fixed minimum percentage for a real win.
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
public browser entry for an open graph, records its raw and gzip size, attributes its module
inputs, and asserts that every implemented live capability remains reachable. It also rejects
server-side parser and generated DOM-inventory modules. Every contributing module must also belong
to an audited live responsibility; a new unclassified dependency fails the same gate.

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

## Reactive speed gate

The [reactive benchmark guide](./reactivity-benchmarks.md) records the full matrix,
reproduction commands and CI measurement controls. `pnpm verify:performance`
compares the six shared HTML Next workloads against main in fresh processes;
it rejects demonstrated slowdowns over 10% in aggregate or 25% in any workload.
Unstable controls produce an inconclusive failure after one retry. The Required
CI job includes this check; the full third-party matrix remains optional.

## Framework rendering comparison

The [framework comparison benchmark](./framework-benchmark.md) is the tracked tooling for keyed
rendering against Solid, Vue, React Hooks and Svelte. The gated target is the Vite-compiled entry (an
app built with Vite and `@nextwebwg/html-next-unplugin`, compiled to the native target): at most
0.99× each of Solid, Vue and React Hooks; Svelte is reported but not gated. The live runtime is
measured alongside it and must stay competitive.

`pnpm setup:frameworks` prepares the pinned fork, `pnpm measure:frameworks` runs a serial sweep of the
Vite-compiled and live entries against the controls, and `pnpm verify:frameworks --base=<ref>` gates
both entries against a base revision in paired sweeps. The gate also fails a Vite-compiled entry that
grows by more than 1 KB gzip or 5%. Recorded summaries form a ledger in `benchmarks/framework-results/`
with every entry's and control's gzip bytes; raw results stay local. To read a summary, start with
`gated_target_met` and `vite_vs_gated_max`, then the per-control `vite_vs_*` and `live_vs_*` ratios
and the `bundles` gzip bytes; only `full_standard` summaries confirm a result (see the
[field reference](./framework-benchmark.md#ledger)). The CI job runs the comparison but is not yet
Required.

### October 2026 owner decisions

The owner decided the following on 2026-10-06 for the live runtime. Decisions for compiled output
are in [the compiled direct path](./compiled-direct-path.md#owner-decisions-2026-10-06).

- **Row evaluation.** Row bindings may be evaluated in one fused update per row, keys may be
  memoized, and an equality selector may re-evaluate only the rows an outer scalar change (such as
  `selected`) affects. Getter read counts and repeated validation warnings for unchanged results are
  not a contract.
- **DOM shape.** Rows may omit their two per-item comment markers (the element is the boundary);
  serialization for hydration re-synthesizes them. `$value` may update the existing Text node's
  `data` instead of replacing the node.
- **Ordering and diagnostics.** When a whole list is replaced with all-new keys, old rows' cleanups
  may run before new rows' first effects (clear-first replace). Controller warnings may name the
  last path used to reach an object instead of the exact index path.
- **Row kernel.** A compile-once row factory for rows of plain native elements is allowed, behind a
  go/no-go measurement before the full build, within the live growth cap below.
- **Not granted.** The lifecycle observer keeps today's exact light-DOM scope. Every other semantic
  stays exact: validation for every evaluation that runs, HR004, mutable keys, pause, resume and
  reconnect, hydration adoption, serialization, no retention (006) and events.
- **Target.** The gated target is the Vite-compiled output at 0.99× or less of Solid, Vue and React
  Hooks each; Svelte is reported, not gated. The live runtime must stay competitive, with no
  regressions.
- **No bundle bloat.** The compiled entry must shrink at every milestone. Live runtime growth is
  capped at +2 KB gzip in total, preferably net-neutral. Byte-heavy changes bought for marginal speed
  are rejected.
- **Baselines.** Experiments start from the current improved state (the latest merged or retained
  best), never from the original baseline.

## Keyed component rendering: confirmed October 2026 results

These results predate the Vite entry: their "compiled-native" figures are an esbuild bundle of the
native generator's output.

Four retained runtime changes removed the dominant dependency-tracking and controller-identity costs and reduced list-clearing work. Through experiment 005, live rendering's weighted time ratio against Solid fell from 4.591× to 1.465×. The target of beating all four framework controls remains unmet: live rendering was still 1.089× React, 1.272× Vue, and 1.424× Svelte. Ordinary compiled-native output was measured separately and reached 1.444× Solid. These are results for one keyed component and its nine workloads, not a general framework ranking.

### Measurement and baseline boundaries

Measurements use [the public js-framework-benchmark fork](https://github.com/nextwebwg/js-framework-benchmark/tree/f566154cc9a70400ca99024f32793f1e25a9eed8), pinned to `f566154cc9a70400ca99024f32793f1e25a9eed8`. Controls are React Hooks 19.2.0, Vue 3.5.39, Svelte 5.42.1, and Solid 1.9.3. The environment was headless Chrome for Testing 153.0.8010.12 on Apple M4 Pro, macOS 26.5.2, with Node 24.20.0 and the upstream Puppeteer runner.

Every retained candidate completed two full standard sweeps: 15 samples per CPU workload, 25 for selection. Reduced exploratory samples identified opportunities only. Each sweep included the original live entry and all four controls; experiments 002, 003, and 005 also included a byte-frozen previous-best live entry for paired incremental comparisons. The candidate's live and ordinary compiled-native entries used the same authored component and controller throughout. No benchmark-specific renderer or new dependency was introduced.

The original comparison entry is pinned to `f86dc05`. Commit `77889b8` corrected native fallback DOM ownership so ordinary compiled-native behavior could be measured; that prerequisite is not counted as an optimization. Its live bundle was byte-identical to the original live bundle (`c5fa33dfd359…`). The initial live baseline combines the original full sweep and an unchanged repeated sweep; ordinary compiled-native was first measured in the repeat. The final workload table below instead keeps the original and candidate entries paired inside both 005 sweeps.

Each workload uses its median total browser duration, not a CPU-profile sample share. The aggregate is a weighted geometric mean; framework ratios divide scores from the same sweep, then take the median across the two sweeps. A ratio below 1 means less time. “Fastest competitor” means the lowest aggregate among the four framework controls, which was Solid here; it does not mean that one implementation won every workload. The nine workload weights, in table order, are 0.642802, 0.560718, 0.564380, 0.192564, 0.132006, 0.527709, 0.564445, 0.550836, and 0.422584.

The `_x16`, `_x8`, and `_x2` suffixes are legacy CPU-throttle labels, not operation counts. The pinned runner's effective throttle factors were 4 for update, selection, swap, and clear; 2 for removal; and unthrottled for the other four workloads. Keep the pinned configuration when reproducing these figures.

### Confirmed framework ratios

| Entry | React Hooks | Vue | Svelte | Solid |
| --- | ---: | ---: | ---: | ---: |
| Original live baseline | 3.404× | 4.085× | 4.493× | 4.591× |
| After 001 (`27860af`) | 1.906× | 2.220× | 2.468× | 2.602× |
| After 002 (`fc49506`) | 1.176× | 1.397× | 1.535× | 1.587× |
| After 003 (`5392613`) | 1.121× | 1.276× | 1.435× | 1.484× |
| After 005 (`537ce4c`) | 1.089× | 1.272× | 1.424× | 1.465× |
| Ordinary compiled-native after 005 | 1.074× | 1.254× | 1.404× | 1.444× |

The required live objectives changed as follows; all remain above the 0.99 target.
These are normalized time ratios, not absolute milliseconds.

| Required comparison | Original → final | Ratio change | Relative reduction |
| --- | ---: | ---: | ---: |
| React Hooks | 3.404 → 1.089 | -2.315 | 68.0% |
| Vue | 4.085 → 1.272 | -2.813 | 68.9% |
| Svelte | 4.493 → 1.424 | -3.069 | 68.3% |
| Solid / fastest competitor | 4.591 → 1.465 | -3.125 | 68.1% |

Ratios in successive rows were collected at different times. Do not add successive percentage gains or infer a tiny win from these aggregates alone. The paired results and control spread determine the incremental decisions.

### Paired workload medians through 005

Each cell contains sweep 1 / sweep 2 medians in milliseconds. The original column is the unchanged `f86dc05` comparison entry measured in those same sweeps.

| Workload | Original live | Live after 005 | Ordinary compiled-native after 005 |
| --- | ---: | ---: | ---: |
| `01_run1k` | 55.0 / 57.1 | 33.7 / 32.9 | 32.2 / 32.6 |
| `02_replace1k` | 64.5 / 60.6 | 40.4 / 37.9 | 39.0 / 38.0 |
| `03_update10th1k_x16` | 24.1 / 17.5 | 22.8 / 15.8 | 22.4 / 16.1 |
| `04_select1k` | 9.8 / 7.3 | 12.3 / 7.3 | 11.2 / 7.6 |
| `05_swap1k` | 94.3 / 90.6 | 30.8 / 28.9 | 34.3 / 27.7 |
| `06_remove-one-1k` | 1081.3 / 1120.4 | 20.6 / 22.2 | 22.3 / 22.5 |
| `07_create10k` | 2110.9 / 1898.8 | 354.6 / 346.2 | 335.3 / 332.6 |
| `08_create1k-after1k_x2` | 224.6 / 215.7 | 41.1 / 35.2 | 40.1 / 34.9 |
| `09_clear1k_x8` | 27.5 / 23.2 | 20.3 / 19.0 | 20.3 / 17.2 |

Selection and updating had much smaller original costs. Selection was 12.3 / 7.3 ms
versus the original's 9.8 / 7.3 ms, and versus the previous best's 10.9 / 7.9 ms.
The first sweep's slowdown did not repeat; no selection improvement or zero-regression
claim follows. Against the unchanged original within these final sweeps, the live
weighted ratio was 0.3098 / 0.3049: 69.0% / 69.5% less weighted time.

### Forecasts and retained changes

| Change | Attributed opportunity before implementation | Confirmed result against its paired baseline |
| --- | --- | --- |
| 001: bound dependency membership scans | Tracking occupied 90.3% of one sampled creation interval and 76.3% of one sampled swap interval. These were ceilings on sampled work, not predicted total-browser gains. | Creation: 390.9 / 408.0 ms versus 2,093.4 / 2,209.2 ms, about 81% lower. Swap: 45.4 / 53.4 ms versus 106.3 / 111.5 ms. Wide effects switch from bounded linked checks to native Set membership while retaining ordered reuse and dynamic cleanup. |
| 002: canonicalize writable controller aliases | Descriptor and nested guard reads occupied about 90.4% of the sampled removal interval. Reassigning guarded facades accumulated reactive wrapper layers. | Removal: 25.4 / 23.6 ms versus 773.4 / 760.3 ms, about 96.8% lower. Append: 46.2 / 41.7 ms versus 64.3 / 60.7 ms, 28–31% lower. A native WeakMap preserves canonical reactive identity while retaining destination guards and readonly barriers. |
| 003: native removal of adjacent stale blocks | Individual `removeChild` calls occupied 59.3% of the sampled clear interval and 20.3% of a sampled replacement interval. | Clear: 18.5 / 20.7 ms versus 26.6 / 28.8 ms, 30.5% / 28.1% lower. The paired weighted improvement was 3.8%. Replacement was +3.2% / −3.9%, so no repeatable replacement win is claimed. Exact fully owned parents use `replaceChildren`; consecutive stale groups use Range deletion; singleton removal keeps its prior path. Effects stop before removal and retained or foreign nodes split groups. |
| 005: clone cached native templates | Static construction and literal DOM writes occupied about 17.8 ms in a sampled pre-change creation interval; a broader 32.9 ms included binding work that remains. These sampled budgets are not comparable to total-browser percentages. | Creation: 33.7 / 32.9 ms versus 37.9 / 36.3 ms (11.1% / 9.4% lower). Create-10k: 354.6 / 346.2 ms versus 390.8 / 364.4 ms (9.3% / 5.0% lower). Append: 41.1 / 35.2 ms versus 44.8 / 39.3 ms (8.3% / 10.4% lower). Paired weighted time fell 5.3% / 3.0%. Native deep cloning and precomputed binding locations share the existing dynamic binding helpers. |

The forecasts attributed existing cost; they did not predict the resulting percentages. Experiment 002's selection was +22% / +4.3% versus its frozen reference, while replacement and clear were modestly slower. Experiment 001 also showed selection uncertainty. Acceptance is not a claim of zero workload regressions: the aggregate improvements were repeatable, behavior checks passed, and no paired confirmed case exceeded the repository's 25% review threshold. In 003, other paired workloads remained within 6% of their reference. In 005, selection was +12.8% / −7.6%, removal −1.9% / +10.4%, and clear −1.0% / +9.2% against the frozen previous best. None exceeded 25%; the small, inconsistent differences remain uncertain.

### Benchmark entry sizes

These are complete benchmark-entry bytes, raw / gzip level 6, for the two measured delivery modes. They are distinct from isolated capability fixtures and the general public browser-entry size gates.

| Stage | Live bytes | Ordinary compiled-native bytes |
| --- | ---: | ---: |
| Baseline | 161,152 / 53,261 | 122,404 / 38,806 |
| After 001 | 161,485 / 53,353 | 122,737 / 38,912 |
| After 002 | 161,553 / 53,368 | 122,805 / 38,927 |
| After 003 | 162,255 / 53,611 | 123,507 / 39,168 |
| After 005 | 164,747 / 54,482 | 126,002 / 39,977 |

Through 005, the live entry added 1,221 gzip bytes and ordinary compiled-native added 1,171 gzip bytes relative to the measurable baseline. The [native runtime audit](./native-runtime-audit.md) records the final product-level sizes and the native mechanisms separately.

### Coverage and remaining work

Cloning applies to fresh ordinary repeated HTML regions. Refs, properties, controls,
resources, custom elements, namespaces, slots, descendant flows, framework-owned DOM,
and existing server DOM retain the ordinary renderer or adoption. The prototype cache
is resolved when a region initializes: two WeakMap lookups outside the row loop, no
per-row cache lookup and no new freezing. Values, validation, listeners, and effect
ownership remain dynamic. Empty and one-row cold-cache costs were not measured.

A fresh profile of three recorded create-10k intervals averaged 89.059 ms of sampled
CPU work. Its leading self costs included DOM insertion (10.195 ms), cloning
(8.621 ms), proxy reads (5.181 ms), mutation synchronization (5.169 ms), and binding-path
resolution (3.766 ms); GC accounted for 10.227 ms without assigned allocation ownership.
These are sampled intervals, not total-browser medians or promised optimization gains.

### Ownership cleanup and retention after 006

The render-owner array retained stopped row effects and their callbacks. Structural
snapshots also missed descendants created after their first render. The ownership
correction removes permanent registrations and owns later-created descendants;
root pause and reconnect retain live effects in creation order. This fixes pre-existing
cleanup failures rather than changing authored bindings or caching application values.

Three fresh Chrome pages performed ten create-1000/clear cycles, sampling after two
animation frames and two forced garbage collections. Between the first and tenth
clear, the previous best retained 90,000 additional DOM nodes in each page despite
showing zero rows. Median JavaScript heap growth was 13.6178 MiB. The corrected
ownership retained no additional DOM nodes, with median heap growth of 0.4513 MiB.
These are retained-node and heap-growth diagnostics, not process RSS, allocation
attribution or a GC-latency saving. Controller handles, references and follower
registries have separate lifetimes; no zero-growth claim applies to the entire library.

Six new browser cleanup regressions fail on the previous best across all three
engines and pass on the correction. All 309 affected runtime/hydration/continuation
checks pass. A fresh primitive comparison against 005 passed: aggregate ratio
0.99994, worst case 1.01091, A/A aggregate spread 0.58%. Fresh `pnpm verify:pr`
passed with 618 Node tests and eight package/CLI checks, including lint, types,
generated artifacts, size gates and package builds.

Both full standard rendering sweeps completed. Paired weighted CPU ratios were
0.98302 and 1.00239: 1.70% less time and 0.24% more time. Their median ratio is
0.99270, about 0.73% less time. The existing 2% decision threshold returned
inconclusive with no violated objective. That threshold is a practical noise guard;
it does not prove a smaller gain is unreal. The owner approved retaining the cleanup
and measured memory improvement independently of a throughput win. This correction
is not counted as an additional CPU keeper.

| Workload | Ownership live A / B, ms | Frozen 005 A / B, ms | Paired change A / B |
| --- | ---: | ---: | ---: |
| `01_run1k` | 29.6 / 34.8 | 29.3 / 35.2 | +1.0% / -1.1% |
| `02_replace1k` | 34.3 / 41.9 | 34.6 / 43.1 | -0.9% / -2.8% |
| `03_update10th1k_x16` | 21.3 / 27.1 | 21.6 / 24.2 | -1.4% / +12.0% |
| `04_select1k` | 10.3 / 12.9 | 10.3 / 12.3 | +0.0% / +4.9% |
| `05_swap1k` | 36.0 / 41.7 | 34.9 / 38.7 | +3.2% / +7.8% |
| `06_remove-one-1k` | 23.7 / 26.2 | 24.2 / 27.6 | -2.1% / -5.1% |
| `07_create10k` | 362.2 / 362.2 | 377.8 / 366.4 | -4.1% / -1.1% |
| `08_create1k-after1k_x2` | 41.6 / 45.1 | 43.8 / 45.5 | -5.0% / -0.9% |
| `09_clear1k_x8` | 21.5 / 22.8 | 21.8 / 23.4 | -1.4% / -2.6% |

Swap was slower in both sweeps; updating was mixed. These costs remain explicit
alongside the memory benefit. The ownership entries contain 165,504 raw / 54,722
level-6 gzip live bytes and 126,760 / 40,236 ordinary compiled-native bytes: +240 /
+259 gzip bytes versus 005. Latest normalized live ratios are React 1.0493, Vue
1.2080, Svelte 1.3818 and Solid 1.4418; ordinary compiled-native ratios are 1.0621,
1.2227, 1.3987 and 1.4594 respectively. Comparing these endpoint ratios to earlier
runs is not evidence of a causal incremental CPU gain; the paired table supplies that
comparison. All four required live targets remain unmet.

A separate sustained diagnostic ran nine rotated candidate/reference/reference rounds,
each with a fresh Chrome process and 100 create1000/clear cycles after three warmups
(2,700 measured cycles total). Main-thread `Performance.TaskDuration` was 5.38% lower
at the median, with reductions of 2.14–8.98% across all nine rounds. The two references
had a median absolute spread of 0.96% and a maximum of 4.33%. Timing included no forced
GC; post-timing GC showed 73 DOM nodes and a median 3.18 MiB JavaScript heap for the
candidate, versus 1,030,073 nodes and 159.93 MiB for the reference. Programmatic button
activation and this repeated workload differ from the official benchmark, so this
supports sustained creation/cleanup without establishing a nine-workload CPU win or
attributing the time reduction specifically to garbage collection.

Prepared component-shaped binding/validation readers, compact row boundaries and
proxy-local metadata remain experiments. WebAssembly has no demonstrated suitable
hot kernel here.

### Binding-reader experiments remain unconfirmed

Prepared readers reduced repeated expression work but added installation cost. One full
standard sweep of shared native-body readers was 2.39% slower against the frozen ownership
reference: label updates were 7.84% faster, while 1,000-row creation was 9.79% slower and
selection 5.97% slower. Sampled profiles showed inherited-scope guards in selection and extra
reader preparation during creation. They did not establish garbage collection as the cause;
sampled GC time was lower in the slower 10,000-row creation interval.

A later prototype removed four wrapper closures per row and deferred reader capture until
an update. Its single diagnostic run used the live candidate, frozen ownership reference and
vanilla across all nine workloads at the standard 15/25 samples. The weighted candidate/reference
ratio was 0.9953. Warm label updates were 13.02% faster and 10,000-row creation 6.55% faster;
1,000-row creation, append and selection were 6.06%, 9.05% and 10.79% slower. This mixed result
has no second sweep, independent framework controls or duplicate A/A reference and is not a
retained optimization or a framework ranking.

The pinned runner warms the same 100 label-update rows three times and selects once before
tracing. Those timings exclude deferred reader preparation. A separate unthrottled diagnostic
used three rotated candidate/reference pairs per workload to measure first and second actual
clicks with CDP TaskDuration and assert unchanged keyed nodes and correct output. Selection
was slower in the first-click pairs; label-update results varied. These small samples include
other main-thread work and do not establish a repeatable first-interaction benefit.

Both reader prototypes remain available for further measurement. A possible follow-up is to
specialize demanded local content reads while retaining cheaper ordinary evaluation for other
bindings. It must preserve validation, getter order, dynamic tracking and late scope shadowing.
The published runtime retains the confirmed cloning and ownership implementations.

### Verification through 005

`pnpm --filter @nextwebwg/html-next verify:performance --base=77889b8` passed
on the final runtime: 27 fresh processes, six workloads, nine rotated candidate/A/A
rounds at iteration scale 40. The median aggregate ratio was 1.0266
(2.7% slower); the worst workload median was
1.0580 (5.8% slower, dynamic-dependencies).
A/A aggregate spread was 0.24%. This passes the existing 10%
aggregate and 25% workload regression limits, while recording the slowdown.

The longer `measure:reactivity --iteration-scale=10` matrix passed its consistency
check and ranked HTML Next third of 14, behind S.js and anod, with 1.10% aggregate
A/A spread. Pota failed expected-result validation; Svelte exhausted Node's default
heap. All six results were checked; excluded libraries have no rank. The standard iteration
setting also passed and ranked HTML Next third of 15, with
1.07% aggregate A/A spread (10.3% worst individual workload spread). Svelte completed
that setting; pota was excluded for an incorrect result. These are Node scalar
reactivity workloads, independent of the browser-rendering comparison.

`pnpm verify:pr` passed: 615 Node tests plus lint, strict types, generated artifacts,
runtime size gates, package builds, and eight package/CLI tests. The Node configuration
skips browser/target configurations; it is not an all-browser pass. Separately, the final
runtime passed 303 Chromium/Firefox/WebKit runtime, server-hydration, and server-continuation
cases, including six focused cloning/fallback cases, and both ordinary benchmark entries
passed the 20-removal/10k-row/keyed-identity/update/event/reconnect/clear smoke check.
Another 118 generated-target runtime tests and three installed-package tests passed.
The complete unrelated browser/parity suites were not rerun. `measure:runtime` produced
exactly the final source's attribution summarized in the native audit; its gzip level 9
figures differ from the benchmark entries' gzip level 6 figures.

Raw profiles, build hashes, runner receipts, summaries, and experiment decisions are stored in the workspace's gitignored `.context/compound-engineering/ce-optimize/component-rendering/` directory. Those local files do not travel with the branch. This checked-in summary should remain self-contained; publishing the raw evidence requires an explicit retained artifact location. Local machine activity was not fully controlled, so paired frozen references, independent controls, and repeated sweeps remain necessary to interpret small differences.
