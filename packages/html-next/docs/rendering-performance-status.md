# Rendering performance: status and next work

Status as of 2026-10-07. The Vite direct entry met the owner's performance target in two full
standard sweeps: **0.988× and 0.982× Solid**, with both also below 0.99× Vue and React.
The retained per-row insertion path reduces the compiled entry from **8,347 B to 8,281 B gzip**.
This record distinguishes merged work from the retained optimization branch and remaining
coverage work. Normative behavior lives in the public proposal
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
- **Coverage.** Everything the live runtime supports must work when compiled. Done: every component
  compiles directly, and the general-runtime fallback and the experimental option are removed.
- **Speed over bytes** (2026-10-07). Keep bytes under control, but take any speed improvement whose
  byte cost is small.
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
| Key-aligned equality/inequality class selection, compiled and live | Merged: nextwebwg/html-next#156 (`0171638`) |
| Forward per-row fresh insertion; fragment branch removed | Retained on `optimize/rendering-gap`; two full standard confirmations below |
| M2 + M3: every component compiled directly with live parity; option, fallback and older emitters removed | `matthew-dean/direct-extend-default` |

M1 moves components with controllers, structured state and keyed lists off
`manageComponentLifecycle`. Its initial receipt with the option on was **8,051 B gzip**
instead of 39,455 B; subsequent harness receipts below use gzip-6. With it off, every flag-off
fixture and the live distributable are
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
  gated target was not met in that sweep: the direct path beats Vue, React and Svelte, but not Solid. This is one sweep;
  confirm it with a second.

- **Keyed selection screen after simplification**, 2026-10-07 (ledger
  `benchmarks/framework-results/20261007T031232Z-49ec400.json`): all nine workloads, compiled/live/Solid,
  reduced samples (5; 15 for select). Compiled selection is **4.2 ms** against Solid's **4.8 ms**;
  live is **5.7 ms**. The compiled weighted ratio is **1.004× Solid**, and live is **1.375×**.
  That screen did not meet the overall target and needed standard-sample confirmation.
  Compiled gzip-6 is **8,347 B** (+48 B over M1); live is **56,168 B** (+738 B).
  Both renderers reuse their existing keyed row map for equality/inequality class bindings whose
  comparand is the loop key. Other comparands retain ordinary evaluation. Live bindings sharing
  an element with ordinary reads of the same root retain their scheduling order.
  `pnpm verify:pr`, focused three-engine runtime and generated-component tests, and the framework
  smoke/parity checks pass.

- **Full standard insertion experiment**, 2026-10-07 (ledger
  `benchmarks/framework-results/20261007T034531Z-354f17d.json`): all seven entries and nine workloads,
  standard samples (15; 25 for select). The source is the merged selector plus
  `KeyedList.fragment = false`; that insertion change was reverted after measurement.

  | Entry | vs Solid | vs Svelte | vs Vue | vs React | gzip-6 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Vite direct experiment | **1.012** | 1.013 | 0.884 | 0.720 | 8,347 B |
  | Live | 1.329 | 1.330 | 1.161 | 0.945 | 56,173 B |

  Compiled and live selection both measured **5.3 ms**, against Solid's **6.5 ms**.
  Compiled remove-one remained **16.2 ms** against **13.4 ms**; its script time was **1.0 ms**
  against **0.5 ms**. That sweep did not meet the overall ≤0.99× Solid target. An earlier reduced screen
  of individual insertion reached 0.975× Solid, which the full run did not confirm.
  Holding all other medians fixed, matching Solid on remove-one would yield approximately
  **0.988× Solid** overall with the benchmark's existing weights. This is a modeled target,
  not a measured improvement.
  Individual insertion used the same gzip bytes and showed promise on creation: 257.1 ms for
  10k rows against Solid's 265.1 ms. It was reverted before a controlled comparison against fragment insertion. At that point
  the default remained `KeyedList.fragment = true`; the continuation below retains per-row insertion.
  Separate reduced screens found no demonstrated gain from `moveBefore = false` or skipping
  ancestor scans for new controller facades; both changes were reverted.

- **Retained insertion continuation**, 2026-10-07: two reversed-order, reduced paired sweeps
  against current main favored per-row insertion: **0.958× and 0.975×** overall. Creation was
  near neutral in that pairing, and unchanged workloads varied; these screens support retention
  but do not establish an exact full-standard speedup against main. The final simplification
  removes the fragment alternative and keeps the same forward `insertBefore` loop.

  Two full standard sweeps measured the same compiled bundle (`6153a30c86ed…`) and the same
  live bundle (`fe9da04d2bcf…`), with all seven entries and all nine workloads:

  | Receipt | vs Solid | vs Svelte | vs Vue | vs React | compiled gzip-6 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | [05:32 sweep](../benchmarks/framework-results/20261007T053217Z-71ed537.json) | **0.988** | 0.963 | 0.874 | 0.742 | 8,281 B |
  | [05:57 sweep](../benchmarks/framework-results/20261007T055730Z-71ed537.json) | **0.982** | 0.958 | 0.868 | 0.734 | 8,281 B |
  | Median of the two ratios | **0.985** | 0.961 | 0.871 | 0.738 | 8,281 B |

  **The gated target is confirmed for this pinned workload and environment.** This does not
  establish a general framework ranking. The exact incremental speed contribution of the
  branch deletion remains unmeasured; its **66 B gzip saving** is measured against the current
  main bundle and the earlier per-row variant, both 8,347 B.
  Live output is byte-identical to current main and measures 55,717 B gzip-6; its Solid ratios
  are 1.286× and 1.309×. This change therefore introduces no live code or bundle regression,
  but it does not close the live performance gap.

  Selection measured 3.7 / 3.5 ms versus Solid's 4.7 / 4.6 ms. Remove-one varied from
  13.0 versus 11.6 ms to 11.4 versus 11.5 ms; its script cost remained about 0.9 ms versus
  Solid's 0.3 ms. Total duration alone is insufficient to attribute a deletion improvement.
  A uniform object-literal controller-facade experiment nearly doubled cold-filter time in
  a Node diagnostic and was reverted. No array-method or validation semantics were changed.
  `pnpm verify:pr` passes (766 Node and 8 package-consumer tests). Framework smoke/parity and
  10 direct generated-runtime browser tests across Chromium, Firefox and WebKit pass; the
  browser run excluded 118 unrelated tests by name. The Node configuration skips 97 browser-only
  suites (2,694 tests), so it does not substitute for those focused browser checks.

## Required next work

The compiled performance target is confirmed. Coverage and default-on remain separate work.
Any further performance experiment starts from this retained state and keeps measured incremental gains.

1. **Selection and insertion: complete for the measured path.** Key-aligned equality/inequality
   class bindings use the existing row map to touch only the old and new selected rows, in
   compiled and live output. Ordinary comparands retain ordinary evaluation. Per-row insertion
   is retained after paired screening, simplification and two full control sweeps.
2. **Further performance headroom.** Remove-one still spends about 0.6 ms more in script than
   Solid in the latest full runs, even when total duration is at parity. Attribute that cost
   before another controller-facade or keyed-reconciliation experiment. Cold `filter` wraps
   each row through `host.state`; callback writes, identity and validation remain contracts.
   The native insertion alternative already passed correctness and three-engine parity checks.
3. **Preserve the confirmation receipts.** The two full sweeps above identify the exact bundles.
   Reduced screens of `moveBefore = false`, new-facade ancestry shortcuts and uniform facade
   construction were reverted because they did not demonstrate a useful gain.
4. **M2 coverage and M3 parity: done.** Every component the parser accepts compiles directly, with
   live-versus-compiled parity in jsdom and three engines; compiled roots answer `getComponentHost`,
   `inspectInstance` and `serializeRenderedForm`, re-synthesize row markers and hydrate live.
5. **Default-on: done.** Compiled output is the only build output. The smaller static,
   primitive-state and scalar-prop emitters did not match live and were folded into the block
   compiler; prop types compile to their own checks.
6. **Live runtime.** The live runtime should share the gains:
   - Adopt `KeyedList` for eligible live rows (M4).
   - Add the live row kernel (approved, +2 KB cap).
   - The key-aligned class selector is already merged; preserve it when adopting the row kernel.

   The live gap map and candidate list are in the analysis archive (`understand/synthesis.md`).
   Experiments 007–009 showed that adding per-row reader allocations on top of today's per-row
   objects regresses creation, so the kernel must replace per-row objects, not add to them.
7. **Known limit.** The indexed coordinator's fast path is skipped when the live runtime's
   coordinator installs first. This costs speed only.
8. **Nightly gate.** The "Framework rendering" workflow runs nightly, because a full comparison exceeds
   the 15-minute CI budget. Treat it as a gate only after its noise is characterized on hosted runners.

## Working method

- **Screen while iterating.** Use about 2 entries and 5 samples, which takes minutes:
  `pnpm measure:frameworks --count 5 --frameworks html-next-vite-candidate solid`,
  optionally with `--benchmarks` for the workloads a change touches.
- **Confirm with full sweeps.** Use standard samples, all controls and `--record` (about 40 minutes).
  PRs use the paired gate, `pnpm verify:frameworks --base=main`.
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
