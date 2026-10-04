# Reactive benchmark results and reproduction

HTML Next ranked **#3 of 15** in the six reactive-primitive workloads measured on
2026-10-04 UTC with Node 24.20.0 on macOS ARM64. This is a result for this workload,
these package versions and this machine, rather than an application-rendering or
universal framework ranking.

[Raw baseline report](./benchmarks/2026-10-04-reactivity-baseline.json) records clean
revision `a4a420601542660f7e56828c7dc6af7b5624ccda`, every framework's workload timings,
ranking and exclusions. The exact dependency versions are fixed by that revision's
`pnpm-lock.yaml`. The older [optimization PR #98](https://github.com/nextwebwg/html-next/pull/98)
also records third place in two valid comparisons against main, with matrix score
improvements of 3.94% and 2.93%; its third comparison was excluded for unstable controls.

## Reproduce from a clean checkout

Use the supported Node 24 line and the repository's Corepack/pnpm pin. From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm measure:reactivity > matrix.json
corepack pnpm report:reactivity:suite > suite.json
```

To repeat the archived result, check out its recorded revision and use its lockfile.
The optional full upstream-suite command was added after that revision; the ranking
matrix command already existed there. No external checkout, local folder, fork,
browser installation or published HTML Next package is needed for the Node matrix.

The full performance runner, adapters and workloads are checked in under
`packages/html-next/scripts/`. All comparison libraries and
`reactive-framework-test-suite` are **devDependencies**, installed from registry
versions in the lockfile. The package publishes only `dist`; the packed-consumer
test verifies that runners, adapters, benchmark reports, tests and benchmark-only
dependencies do not ship or install for npm consumers.

## What the ranking measures

| Workload | Iterations per sample | Shape |
| --- | ---: | --- |
| Signal write/read | 50,000 | Write a signal and read the latest value |
| Effect propagation | 10,000 | One subscribed effect |
| Computed chain | 5,000 | Ten computed nodes and a subscribed effect |
| Diamond | 5,000 | Two computed branches joining into one |
| Dynamic dependencies | 2,000 | Switch active branches, then update the selected source |
| Fanout | 1,000 | One signal observed by 32 effects |

Each workload checks its final value before accepting a timing. Each framework runs
in five fresh processes; each process uses two warmups and five measured samples.
The report takes medians and scores each library by the geometric mean of its
ratios to the fastest measured library in each workload. Smaller scores are better.
It rotates library order and runs an additional HTML Next process in each round as
an A/A control. `--iteration-scale=10` lengthens timed sections without changing graph
shape; report that setting with any comparison.

The archived run attempted 16 libraries and ranked 15. Pota was excluded because
its adapter returned an incorrect final value; the raw report records the failure.
Anod and S.js placed first and second. HTML Next placed ahead of alien-signals,
Preact signals, Vue reactivity, Solid, MobX and the TC39 signal polyfill on this setup.
This compares signal engines through adapters, including Node-compatible client
entries for Solid, Svelte and Pota; it does not compare whole framework applications.

The archived aggregate A/A difference was 4.86%, within the matrix's 5% check.
The largest individual workload difference was 11.90%, so this report does not
establish small per-workload advantages. Current reports additionally include raw
process samples, CPU/OS/ICU metadata, package versions and the lockfile hash.
The matrix exits unsuccessfully when its stability/coverage check fails; retain
failed reports as inconclusive evidence instead of using their ranking in a headline.

## Full upstream correctness suite

`report:reactivity:suite` runs every exported case from the pinned upstream
`reactive-framework-test-suite` against the checked-in HTML Next adapter, with a
bounded worker process. It reports failures and optional-capability skips alongside
passes, and keeps behavioral choices separate. Version 0.1.0 currently exports
196 cases: this run produced **139 passes, 10 failures, 30 skips and 17 behavioral
results**. These are diagnostic results, not a passing conformance gate or a speed
ranking. The command returns a report; inspect its `summary` and individual cases.
The existing focused upstream tests remain part of normal verification.

## Small CI regression gate

```sh
git fetch origin main
corepack pnpm verify:performance --base=origin/main --output=performance.json
```

CI compares the PR with its main base SHA; a main push compares with the previous
main SHA. It bundles both revisions with the same installed esbuild, Node and
lockfile, then measures only HTML Next using the same six workload definitions.
A temporary `git archive` of the baseline source avoids changing the checked-out
branch or requiring a separate maintained checkout. Both revisions use the same
adapter and iteration scale of 40. This is a representative signal-engine gate;
it does not time DOM rendering, formatter work, or all third-party libraries.

Nine rounds each measure the candidate and two independent baseline processes,
rotating the candidate's position. Baseline controls must agree within 5% in the
aggregate and 10% for every workload. Noisy runs get one bounded retry; persistent
noise fails as **inconclusive**, never as a demonstrated regression or a silent pass.
For each paired ratio, the candidate is divided by the geometric mean of its two
controls. The second-smallest of nine ratios is a conservative one-sided sign-test
bound (98.05% coverage for an independent continuous sample median). A stable run
fails for a demonstrated slowdown greater than **10% overall** or **25% in any
workload**. Smaller changes remain visible for review; these budgets are rejection
limits, not claims that every smaller regression is acceptable.

All samples and judgments are emitted as JSON in CI logs and can be saved with
`--output`. The Required check includes this job. Library ranking is deliberately
not a CI threshold: new library versions and other engines' improvements should
not make an unchanged HTML Next implementation fail.
