# Framework comparison benchmark

`scripts/framework-benchmark.ts` measures keyed component rendering against framework controls on
[the public js-framework-benchmark fork](https://github.com/nextwebwg/js-framework-benchmark/tree/f566154cc9a70400ca99024f32793f1e25a9eed8),
pinned to `f566154cc9a70400ca99024f32793f1e25a9eed8`. It replaces the untracked harness that
produced the [October 2026 rendering results](./runtime-performance.md#keyed-component-rendering-confirmed-october-2026-results);
the protocol and scoring are unchanged. Scoring lives in `scripts/framework-benchmark-score.ts` and
is unit tested.

## Commands

Run these from the repository root with the supported Node line. Prefix them with
`fnm exec --using 24.20.0` when Node is managed by fnm.

| Command | Purpose |
| --- | --- |
| `pnpm setup:frameworks [--force]` | Create or refresh the ignored checkout `packages/html-next/.benchmark/js-framework-benchmark`. |
| `pnpm measure:frameworks [options]` | Build the candidate entries and run one serial sweep against the controls. |
| `pnpm verify:frameworks --base=<ref> [--count=<n>] [--output=<file>]` | Paired gate: the working tree's live entry against `<ref>` (default `origin/main`). |
| `pnpm smoke:frameworks [--removals=<n>]` | Functional check of both candidate entries in Chromium. |

Setup makes a sparse, blob-filtered checkout of the pinned fork containing only the runner
(`webdriver-ts`), server, CSS and the `html-next`, `vanillajs`, `react-hooks`, `vue`, `svelte` and
`solid` keyed entries. It verifies the checked-out revision and the four controls'
`package-lock.json` SHA-256 values, then runs `npm ci` and the fork's own build for the runner, the
server and each control. Completed steps are skipped for the same pin unless `--force` is passed.

`measure:frameworks` options:

- `--frameworks <names...>`: entry directories to run. The default is `html-next-live-candidate`,
  `html-next-compiled-candidate`, `vanillajs`, `vue`, `react-hooks`, `svelte` and `solid`. The fork's
  original `html-next` entry can be added by name.
- `--benchmarks <prefixes...>`: workload prefixes such as `01_ 09_`; the default is all nine.
- `--count <n>`: CPU samples per workload. Omit it for the standard 15 (25 for selection).
- `--reference <git ref>`: also build `html-next-live-reference` from that revision's
  `packages/html-next/src`. With `--reference=HEAD` and a clean tree it is an A/A control.
- `--record`: also write the summary to the ledger (below).

Each run writes `packages/html-next/.benchmark/runs/<UTC stamp>/` with the runner's `results/`,
`traces/`, `runner.log`, `server.log`, `command.json` and `summary.json`. Raw results and traces stay
out of Git.

## Entries and runtime boundary

All HTML Next entries use the authored `benchmark-app.html` and `controller.js` from the fork's
`frameworks/keyed/html-next` entry. The live entry is an esbuild bundle of `src/browser.ts`; the
compiled entry is that component through `parseComponent` and `generateVanilla`, bundled with the
same settings (ES2022, minified, no legal comments). Each entry's `frameworkVersion` carries the
first 12 hex digits of its bundle's SHA-256, so result names identify the measured bytes. Entries are
real directories under the checkout's `frameworks/keyed/`.

The command starts the fork's server for its own checkout and stops it afterward. The pinned runner
and server only use port 8080, so a run fails if anything else listens there. It also refuses to
start while another `benchmarkRunner` process is active.

## Protocol

Measurements must be serial on a quiet machine: one runner, one browser, and no builds, tests or
other benchmarks running alongside it. The runner is the fork's unchanged
`webdriver-ts/dist/benchmarkRunner.js` with Puppeteer, `--headless` and Playwright's Chromium
(`--chromeBinary`). Its CPU throttling is fixed by the pin: 4× for update, selection, swap and clear;
2× for removal; none for the other four workloads.

A standard sweep takes 15 samples per CPU workload and 25 for selection. Each workload uses the
median of `values.total.values`. An entry's score is the weighted geometric mean of its medians
relative to the fastest entry for each workload in the same sweep, using the weights in
[the runtime performance guide](./runtime-performance.md#measurement-and-baseline-boundaries).
Ratios divide scores from the same sweep: `live_vs_<control>`, `live_vs_fastest_competitor` (against
the lowest-scoring of the four controls), `compiled_vs_fastest_competitor`, and `live_vs_reference`
when a reference is measured. A run with fewer samples or workloads is marked `reduced`; it can
locate opportunities but does not confirm them.

## Gate

`verify:frameworks` builds the working tree's live entry and the base revision's live entry, then
runs paired sweeps containing only those two entries. Each sweep yields a weighted candidate/reference
ratio and nine per-workload ratios.

- A sweep fails when its weighted ratio exceeds 1.03 or any workload ratio exceeds 1.25, the
  repository's 25% hot-path review threshold.
- The same failed limit in two sweeps is a `regression`. Two clean sweeps `pass`.
- When the first two sweeps disagree, one extra sweep is run. Anything still undecided is
  `inconclusive`. A regression is never retried to obtain a pass.
- Identical candidate and reference bundles pass without browser sweeps.

Only `pass` exits successfully; `inconclusive` needs a quieter rerun. `--count` permits a quick local
check but marks the report `reduced`. The JSON report records both revisions, the dirty flag, the
environment, both bundles, every sweep's medians and the assessment.

The CI job "Framework rendering against main" runs the gate when `packages/html-next/src` changes. It
is not part of the Required job until its noise on hosted runners is known.

## Ledger

`measure:frameworks --record` writes the same summary to
`packages/html-next/benchmarks/framework-results/<UTC stamp>-<short commit>.json`. The summary holds
the medians, scores and ratios; the protocol; the environment (Chrome, CPU, OS, Node, fork revision,
control lockfile hashes, HTML Next commit and dirty flag); and each entry bundle's SHA-256 and raw and
gzip (level 6) bytes. Record full standard runs from a quiet machine; reduced runs are exploratory.
The ledger begins with the pre-tracking A/A sweep of `20261006T200518Z`, imported with its original
scores.
