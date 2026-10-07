# Rendering performance: status and next work

Status as of 2026-10-07. This is the working record for the effort to make html-next's keyed
rendering beat the framework controls. It covers what is merged, what is open, what has been
measured, and what is required next. Normative behavior lives in the public proposal
(`nextwebwg/specs`). Design and decisions live in [compiled-direct-path.md](./compiled-direct-path.md)
and in the "October 2026 owner decisions" section of [runtime-performance.md](./runtime-performance.md).

## Goal

These are the owner's targets, set on 2026-10-06.

- **Gated target.** The **Vite-compiled** output (`@nextwebwg/html-next-unplugin`, vanilla target)
  must be **≤ 0.99×** each of Solid 1.9.3, Vue 3.5.39 and React Hooks 19.2.0. The measure is the
  pinned keyed js-framework-benchmark: a weighted geometric mean of median total durations over nine
  workloads. Svelte 5.42.1 is reported but not gated.
- **Live runtime.** The live runtime must stay competitive: no regressions, and it should share the
  gains.
- **Bundle cost.** Prefer smaller compiled output. The owner accepts a small increase, including
  roughly 50 B gzip for selection, when it improves performance against Solid. Live may grow by
  at most +2 KB gzip in total, and preferably not at all.
- **Coverage.** Everything the live runtime supports must work when compiled. The general-runtime
  fallback (`notYetDirect()`) is transitional.
- **Starting point.** Experiments always start from the current improved state, never the original
  baseline.

## Where things are

| Work | State |
| --- | --- |
| Earlier CPU and memory keepers (001–006) | Merged: nextwebwg/html-next#144 (`cae92ab`) |
| E1, exact-equivalence live bookkeeping trims | Merged: nextwebwg/html-next#149 (`222eb27`) |
| Tracked framework benchmark harness ([framework-benchmark.md](./framework-benchmark.md)) | Merged: nextwebwg/html-next#150 (`c33c781`) |
| Harness keeps out of the shared Playwright browser cache | Merged: nextwebwg/html-next#152 (`bb67645`) |
| Plain-object template reads (another session) | Merged: nextwebwg/html-next#154 (`009a08a`) |
| Fork entry `frameworks/keyed/html-next` runs the improved runtime | Merged: nextwebwg/js-framework-benchmark#2 (`1c5c091`); the harness pins this commit |
| **M0 + M1, compiled direct path behind `experimentalDirectExtend`** | **Merged: nextwebwg/html-next#155** (`eba4fa0`) |

M1 moves components with controllers, structured state and keyed lists off
`manageComponentLifecycle`. With the option on, the benchmark component's Vite entry is **8,051 B
gzip** instead of 39,455 B. With it off, every flag-off fixture and the live distributable are
unchanged from `main`. Review findings were fixed before the PR. The two remaining known limits are
listed below.

## Measurements

All sweeps run on an Apple M4 Pro, macOS 26.5.2, Chrome for Testing 153.0.8010.12 and Node 24.20.0,
with standard samples (15, or 25 for select) unless marked otherwise.

- **Baseline A/A, 2026-10-06** (ledger seed): live was 1.453× Solid, 1.404× Svelte, 1.254× Vue and
  1.048× React. Compiled through the old esbuild path was 1.424× Solid.
- **E1 CI gate** (hosted runner, paired against `main`, not Required):
  - Live: 0.958 and 0.942. Passed, about 5% faster.
  - Vite runtime-path entry: 0.941, 1.027 and 0.962. Passed on the bounded third sweep.
  - The roughly 9% sweep-to-sweep spread on hosted runners is why that job is not yet Required.
- **First full sweep of the direct entry**, 2026-10-07 (`--direct-extend`, quiet machine, single sweep, ledger
  `benchmarks/framework-results/20261007T020114Z-f162c91.json`):

  | Entry | vs Solid | vs Svelte | vs Vue | vs React | gzip-6 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Vite direct (M1) | **1.029** | 0.978 | 0.847 | 0.745 | 8,299 B |
  | Live | 1.367 | 1.298 | 1.124 | 0.989 | 55,430 B |

  Medians in ms (direct entry vs Solid / vanillajs): run1k 23.8 vs 24.2 / 22.3; replace1k 27.9 vs 27.0 / 26.1;
  update10th 21.3 vs 21.2 / 24.5; select1k 7.1 vs 5.5 / 4.6; swap1k 16.6 vs 16.2 / 14.7; remove-one 13.7 vs
  11.7 / 13.0; create10k 258.1 vs 261.3 / 242.1; append1k 26.7 vs 27.0 / 25.6; clear1k 13.4 vs 13.8 / 11.5.
  Against Solid, the remaining gap comes from **remove-one** (largest weighted share), then **select**, then
  **replace**. Parity on all three projects to about 0.993×, so ≤ 0.99 also needs small wins elsewhere. The
  gated target is not met yet: the direct path beats Vue, React and Svelte, but not Solid. This is one sweep;
  confirm it with a second.

- **Keyed selection screen after simplification**, 2026-10-07 (ledger
  `benchmarks/framework-results/20261007T031232Z-49ec400.json`): all nine workloads, compiled/live/Solid,
  reduced samples (5; 15 for select). Compiled selection is **4.2 ms** against Solid's **4.8 ms**;
  live is **5.7 ms**. The compiled weighted ratio is **1.004× Solid**, and live is **1.375×**.
  The overall target remains unmet and this screen needs standard-sample confirmation.
  Compiled gzip-6 is **8,347 B** (+48 B over M1); live is **56,168 B** (+738 B).
  Both renderers reuse their existing keyed row map for equality/inequality class bindings whose
  comparand is the loop key. Other comparands retain ordinary evaluation. Live bindings sharing
  an element with ordinary reads of the same root retain their scheduling order.
  `pnpm verify:pr`, focused three-engine runtime and generated-component tests, and the framework
  smoke/parity checks pass.

## Required next work

In order. Each item is screened first (see Working method), then confirmed.

1. **Equality selector. Key-aligned class bindings implemented and screened; confirmation remains.** M1's plan rejected a selector
   index as worth about 0.1 ms, but the measured `04_select1k` is 7.1 ms against Solid's 5.5. It is the second-largest remaining share and the one the owner explicitly requires.
   Before the selector, every row's `class:danger="row.id = selected"` binding re-evaluated when
   `selected` changed. With `$key="row.id"`, the new path touches only the affected rows.
   - **Allowed.** The owner allowed this in decision 1 (an outer scalar change may re-evaluate only
     the affected rows; getter counts and repeated warnings for unchanged results are not a
     contract).
   - **Design.** For bindings whose expression is `itemPath = outerRoot` (or `!=`), keep an index
     from comparand value to rows, maintained on row create, key change and removal. A write to the
     root then touches only the rows for the old and new values. Use SameValueZero.
   - **Trace first.** Profile the sweep's select traces before building. The live analysis found
     about 2 ms of non-script time (paint and other) in select that a selector does not remove.
     Build the selector, then attack whatever remains.
   - **Scope and budget.** Do it in the compiled direct path (`targets/vanilla-blocks.ts` emission
     plus a `generated-runtime.ts`/`keyed.ts` helper, imported only by components that use the
     pattern) and in the live runtime. Keep the byte budget: shared helper ≤ ~0.2 KB gzip.
2. **Remove-one, then replace.** Remove-one is the largest remaining weighted share
   (13.7 ms vs Solid 11.7, slower than vanillajs at 13.0).
   - The controller runs `rows.filter(...)` through the `host.state` facade. Rows created by `run()` were
     never read through the facade, so `filter` builds a cold facade per row. `KeyedList` then reconciles
     999 retained rows.
   - Profile the sweep's remove traces. Reconsider array-method instrumentation (Vue-style raw `filter`/`concat`
     with lazy wrapping). The M1 plan rejected it at an estimated ≈0.3 ms for +0.3 KB, but remove-one alone
     is now worth more than that.
   - Then check replace (27.9 vs 27.0).
3. **Confirm M1.**
   - Run a second full sweep (`pnpm measure:frameworks --direct-extend --record`).
   - Screen `KeyedList.moveBefore = false` on swap: `moveBefore` is the suspected cause of the swap
     PrePaint excess.
   - Screen fragment insertion against per-row insertion.
   - Keep whichever wins on measurements.
4. **M2 coverage.** Work through the coverage table in
   [compiled-direct-path.md](./compiled-direct-path.md#coverage-plan) one feature per commit, each
   with its byte line, live-vs-compiled parity fixtures and a Node eligibility test. The benchmark
   entry must stay ≤ its M1 receipt.
5. **M3 parity, then default-on.** The owner has approved default-on once these hold:
   - `getComponentHost`, `inspectInstance` and `serializeRenderedForm` work on compiled roots;
   - markers are re-synthesized;
   - the coordinators are deduplicated;
   - props, slots and invocations compile directly;
   - the serialization round trip and three-engine parity pass.

   Then make `experimentalDirectExtend` the default.
6. **Live runtime.** The live runtime should share the gains:
   - Adopt `KeyedList` for eligible live rows (M4).
   - Add the live row kernel (approved, +2 KB cap).
   - Add the selector (item 1).

   The live gap map and candidate list are in the analysis archive (`understand/synthesis.md`).
   Experiments 007–009 showed that adding per-row reader allocations on top of today's per-row
   objects regresses creation, so the kernel must replace per-row objects, not add to them.
7. **Known limits from M1.**
   - A graph that mixes older direct components that have a lifecycle (such as `prop-button`) with
     direct-extend components bundles both coordinators: +184 B gzip-9. This is planned for M3.
   - The indexed fast path is skipped when another coordinator installs first. This costs speed only.
8. **CI gate.** Make "Framework rendering against main" Required only after its noise is
   characterized on hosted runners. It should probably run with `--direct-extend` once that is the
   default.

## Working method

- **Screen while iterating.** Use about 2 entries and 5 samples, which takes minutes:
  `pnpm measure:frameworks --direct-extend --count 5 --frameworks html-next-vite-candidate solid`,
  optionally with `--benchmarks` for the workloads a change touches.
- **Confirm with full sweeps.** Use standard samples, all controls and `--record` (about 40 minutes).
  PRs use the paired gate, `pnpm verify:frameworks --base=main --direct-extend`.
- **Measure serially on a quiet machine.** Other sessions on this machine also use port 8080 and the
  CPU. Coordinate before a timed run, and treat timings taken under load as noise.
- **Read the rules.** AGENTS.md applies: native-first audit, separation of the live interpreter from
  generated output, and size gates. Owner decisions are recorded in the docs listed at the top. Ask
  the owner before any semantic change those decisions do not cover.

## Analysis archive (machine-local)

`~/.local/share/compound-engineering/handoffs/html-next-207b62de/rendering-performance-next-20261007/analysis/`
on the owner's machine holds:

- the live-runtime gap analysis (`understand/`: synthesis, profiles, competitor techniques);
- the compiled-path designs and the full M1 implementation spec (`compiled/spec.md`, with M2–M4
  detail, risks and rejected ideas);
- the E1 and M1 implementation records;
- the workflow scripts;
- the pre-tracking harness and its runs.

It is supporting material, not authority. Where it and this document disagree, re-measure.
