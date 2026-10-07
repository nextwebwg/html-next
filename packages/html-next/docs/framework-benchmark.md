# Framework comparison benchmark

`scripts/framework-benchmark.ts` measures keyed component rendering against framework controls on
[the public js-framework-benchmark fork](https://github.com/nextwebwg/js-framework-benchmark/tree/1c5c091eb0dbc2316f4ad3b23658fe2be617747e),
pinned to `1c5c091eb0dbc2316f4ad3b23658fe2be617747e`. It replaces the untracked harness that
produced the [October 2026 rendering results](./runtime-performance.md#keyed-component-rendering-confirmed-october-2026-results);
the protocol and scoring are unchanged. Scoring lives in `scripts/framework-benchmark-score.ts` and
is unit tested.

## Target

The gated target is the **Vite-compiled** entry: the benchmark component built as a Vite app with
`@nextwebwg/html-next-unplugin`, which compiles components to the native (vanilla) target. It must
reach 0.99× or less of Solid, Vue and React Hooks each (`vite_vs_gated_max` ≤ 0.99). Svelte is
measured and reported but not gated. The live runtime is measured alongside it and must stay
competitive: the paired gate rejects live regressions too.

Bundle size is part of the target. Every run records the shipped JavaScript of each HTML Next entry
and each control, and the gate fails a Vite-compiled entry that grows (below).

## Commands

Run these from the repository root with the supported Node line. Prefix them with
`fnm exec --using 24.20.0` when Node is managed by fnm.

| Command | Purpose |
| --- | --- |
| `pnpm setup:frameworks [--force]` | Create or refresh the ignored checkout `packages/html-next/.benchmark/js-framework-benchmark`. |
| `pnpm measure:frameworks [options]` | Build the HTML Next entries and run one serial sweep against the controls. |
| `pnpm verify:frameworks --base=<ref> [--count=<n>] [--output=<file>]` | Paired gate: the working tree's Vite-compiled and live entries against `<ref>` (default `origin/main`). |
| `pnpm smoke:frameworks [--removals=<n>]` | Functional check of the Vite-compiled and live entries in Chromium. |

Setup makes a sparse, blob-filtered checkout of the pinned fork containing only the runner
(`webdriver-ts`), server, CSS and the `html-next`, `vanillajs`, `react-hooks`, `vue`, `svelte` and
`solid` keyed entries. It verifies the checked-out revision and the four controls'
`package-lock.json` SHA-256 values, then runs `npm ci` and the fork's own build for the runner, the
server and each control. Each step's marker records the pinned Git tree of its directory, so a repin
rebuilds only the directories it changed; an existing checkout at an earlier pin is fetched, checked
out and migrated in place, and entries generated for the earlier pin are removed. `--force` refetches
and rebuilds everything. Every command also refuses a checkout that has left the pin or has modified
tracked files, such as an edited `controller.js`; `setup:frameworks --force` restores it. The ledger's
fork revision and lockfile hashes are therefore the checked values, not assumptions.

`measure:frameworks` options:

- `--frameworks <names...>`: entry directories to run. The default is `html-next-vite-candidate`,
  `html-next-live-candidate`, `vanillajs`, `solid`, `vue`, `react-hooks` and `svelte`. The fork's
  own `html-next` entry can be added by name (below).
- `--benchmarks <prefixes...>`: workload prefixes such as `01_ 09_`; the default is all nine.
- `--count <n>`: CPU samples per workload. Omit it for the standard 15 (25 for selection).
- `--reference <git ref>`: also build `html-next-live-reference`, the live entry from that revision.
  With `--reference=HEAD` and a clean tree it is an A/A control; entry positions are fixed here, so it
  includes any position effect as well as noise.
- `--record`: also write the summary to the ledger (below).

Each run writes `packages/html-next/.benchmark/runs/<UTC stamp>/` with the runner's `results/`,
`traces/`, `runner.log`, `server.log`, `command.json` and `summary.json`. Raw results and traces stay
out of Git.

## Entries and runtime boundary

All HTML Next entries use the authored `benchmark-app.html` and `controller.js` from the fork's
`frameworks/keyed/html-next` entry, and are real directories under the checkout's `frameworks/keyed/`.

- `html-next-vite-candidate`: a Vite app laid out like the fork's Vue entry. Its `index.html` links
  `/css/currentStyle.css` and loads `main.js`, which imports `createBenchmarkApp` from
  `virtual:html-next/components` and appends it to `body`. `vite build` runs with the unplugin's
  default native target (no framework conversion), `base: "./"` and target ES2022, into `dist/`
  (`customURL: "/dist"`). The plugin and the `@nextwebwg/html-next` source it compiles with, and the
  runtime modules the generated code imports, all come from the tree being measured (the working
  tree, or an extracted `--base` revision), never from a published or prebuilt package. Every
  component compiles to direct DOM code ([compiled components](./compiled-direct-path.md)); a base
  revision from before that change builds as it shipped, which for this entry was the general runtime.
- `html-next-live-candidate`: an esbuild bundle of `src/browser.ts` (ES2022, minified, no legal
  comments) with the fork's `index.html` and `bootstrap.js`.
- `html-next`: the fork's own entry, not rebuilt by this tool. At the pin its checked-in live bundle
  is the `cae92ab` runtime (`frameworkVersion` `1.0.0-alpha.30+cae92ab`), a fixed public reference for
  the improved live baseline.

Each built entry's `frameworkVersion` is `<package version>+<first 12 hex digits of its JavaScript's
SHA-256>`, so result names identify the measured bytes. An entry's size receipt is the SHA-256 of its
shipped JavaScript files in name order, their raw bytes, and the sum of each file's gzip (level 6)
bytes: the Vite entry's `dist/assets/*.js`, the live `browser-loader.bundle.js`, and for the controls
Solid, Svelte and React Hooks `dist/main.js`, Vue `dist/assets/*.js` and vanillajs `src/Main.js`.

The command starts the fork's server for its own checkout and stops it afterward. The pinned runner
and server only use port 8080, so a run fails if anything else listens there. It also refuses to
start while another `benchmarkRunner` process is active. Both checks run before any entry is rebuilt,
so a refused command never rewrites an entry another run is loading.

The smoke check exercises both entries with seeded labels, then requires their component markup to
be identical at seven checkpoints (after update, select, swap, removals, append, reconnect and clear).
Per-item comment markers are left out of that comparison, because rows may omit them (owner decision
of 2026-10-06; compiled rows do).

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
Ratios divide scores from the same sweep. A run is `full_standard` only with standard samples, all
nine workloads and the whole default entry set, because scores are relative to the fastest entry in
the sweep; anything else is marked `reduced`. A reduced run can locate opportunities but does not
confirm them.

## Gate

`verify:frameworks` builds both modes, Vite-compiled and live, from the working tree and from the base
revision, and runs paired sweeps of those four entries. Each sweep yields, per mode, a weighted
candidate/base ratio and nine per-workload ratios.

The runner orders entries by the server's directory listing, not by its arguments, so the gate
builds each side into neutral entries `html-next-<mode>-a` and `html-next-<mode>-b` and swaps them
between sweeps. Neither side always runs first. Each comparison records its sweep and which entry
held the candidate.

- A sweep fails a mode when its weighted ratio exceeds 1.03 or any workload ratio exceeds 1.25, the
  repository's 25% hot-path review threshold. The gate is deliberately stricter than that rule: it
  does not apply the rule's 1 KB / 5% gzip savings exemption. A size-saving trade therefore fails and
  goes to owner review with both bundle sizes in the report.
- The same failed limit in two sweeps is a `regression`. Two clean sweeps `pass`.
- When a mode's first two sweeps disagree, one extra sweep runs for that mode only. Anything still
  undecided is `inconclusive`. A regression is never retried to obtain a pass.
- A mode whose candidate and base bundles are identical passes without browser sweeps.
- No bundle bloat: the Vite-compiled mode is a `regression` when its gzip bytes grow by more than
  1 KB (1,024 bytes) or by more than 5% of the base, whichever is smaller. Live sizes are reported but
  not gated here.

Each mode reports its own status; the gate passes only when both pass, and fails as `regression` if
either regressed, otherwise as `inconclusive`. `inconclusive` needs a quieter rerun. `--count` permits
a quick local check but marks the report `reduced`. The JSON report records both revisions, the dirty
flag, the environment, and per mode the bundles, size assessment, comparisons and speed assessment,
followed by every sweep's medians.

The nightly "Framework rendering" workflow runs the gate against main as of 24 hours earlier when
`packages/html-next/src` or `packages/html-next-unplugin/src` changed since then; it can also be run
manually with a base commit. A full comparison exceeds the 15-minute CI budget, so pull requests do
not run it, and it is not a release gate until its noise on hosted runners is known.

## Ledger

`measure:frameworks --record` writes the same summary to
`packages/html-next/benchmarks/framework-results/<UTC stamp>-<short commit>.json`. Record full
standard runs from a quiet machine; reduced runs are exploratory. A summary holds:

- `protocol`, `cpu_samples`, `frameworks`, `benchmarks`, and the `environment` (Chrome, CPU, OS, Node, fork revision, control
  lockfile hashes, HTML Next commit and dirty flag).
- `bundles`: each entry's size receipt, HTML Next entries and controls alike, with
  `vite_gzip_bytes` and `live_gzip_bytes` repeated at the top level. Ledger entries recorded before
  every component compiled directly also carry `direct_extend` and a Vite receipt's `directExtend`,
  from the removed `--direct-extend` option.
- `median_ms` and `scores` per entry, and `controls` mapping each control to its result name.
- For each mode `vite` and `live`: `<mode>_score`, `<mode>_vs_<control>` for every control that ran
  (`react_hooks`, `vue`, `svelte`, `solid`), `<mode>_vs_gated_max` (the largest of the Solid, Vue and
  React Hooks ratios; present when all three ran) and `<mode>_vs_fastest_competitor` (against the
  lowest-scoring of all four controls; present when all four ran).
- `gated_target_met`: whether `vite_vs_gated_max` ≤ 0.99. Ratios below 1 mean less time.
- `live_vs_reference` when a reference was measured.

The ledger begins with the pre-tracking A/A sweep of `20261006T200518Z` at the previous pin
`f566154`, imported with its original scores. That harness had no Vite entry: its
`html-next-compiled-candidate` and `compiled_*` fields are an esbuild bundle of `generateVanilla`
output, a diagnostic that this tool no longer builds. Compare its `live_*` fields with later runs,
not its compiled ones.
