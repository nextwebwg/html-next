# Native rendering against Fluid

The single-pass inert renderer reduced total native rendering time by **30.4%** across five retained-template workloads on one Apple M4 Pro host. Each workload used **23% to 37% less time than Fluid** after the change. The computed cart changed from approximately 16% more time than Fluid to 23% less time. These results describe the measured workloads and warm rendering.

The change is included in `NextWebWG.HtmlNext` `1.0.0-alpha.2`. The first NuGet version, `1.0.0-alpha.1`, contains the original renderer and the HTML Next gallery icon and branded README.

## Rendering measurements

Each row shows the median of three independent BenchmarkDotNet ShortRun means. Times are microseconds per render. The last column is the median of the three within-run native/Fluid ratios, so it can differ slightly from dividing the displayed median times.

| Workload | Original native | Single-pass native | Fluid alongside candidate | Native/Fluid |
| --- | ---: | ---: | ---: | ---: |
| Escaped card | 0.209 | 0.164 | 0.224 | 0.732 |
| Computed cart, 100 rows | 32.316 | 20.918 | 27.053 | 0.772 |
| Product list, 10 rows | 1.793 | 1.310 | 2.084 | 0.629 |
| Product list, 100 rows | 17.889 | 12.353 | 18.596 | 0.664 |
| Product list, 1,000 rows | 208.642 | 146.901 | 213.567 | 0.688 |

The median sum of the five native render times fell from **261.104 μs to 181.788 μs**, a reduction of **79.316 μs, or 30.38%**. This aggregate weights each case once and is dominated by the 1,000-row list. It is a median of per-run sums, rather than the sum of the displayed row medians.

The median worst native/Fluid ratio fell from **1.16239 to 0.77158**, a reduction of 0.39081. Both approved targets were met: total native time below 213.958 μs and a worst native/Fluid ratio below 0.95. The candidate total samples ranged from 176.790 to 182.835 μs; the original samples ranged from 260.512 to 269.594 μs. Candidate worst ratios ranged from 0.76863 to 0.77884.

## Allocation measurements

BenchmarkDotNet reported the same median bytes allocated per native render before and after the change. These are warmed measurements; first-use buffer rentals and retained pool capacity are not represented by per-operation allocation alone.

| Workload | Original native bytes | Single-pass native bytes | Fluid bytes |
| --- | ---: | ---: | ---: |
| Escaped card | 240 | 240 | 704 |
| Computed cart, 100 rows | 19,072 | 19,072 | 54,251 |
| Product list, 10 rows | 1,984 | 1,984 | 4,648 |
| Product list, 100 rows | 19,264 | 19,264 | 37,770 |
| Product list, 1,000 rows | 195,728 | 195,728 | 502,919 |

## Why one pass helps

The original `Render` binds application data once, counts the rendered output, then executes the output plan again to fill an exact-size string. Simple inert templates repeat scalar evaluation, HTML escaping and numeric formatting during those two output passes.

The candidate renders context-free inert templates once into a 256-character stack buffer. When output exceeds that capacity, it rents a growing character array, copies the completed output and continues. It creates the final string from the written range, then clears and returns rented arrays on success or failure. The shared pool can retain cleared capacity for reuse.

Component graphs, interactive output and module preparation continue to use their counting and replay path. Their retained child snapshots, prepared module records and hydration metadata follow the existing renderer. `Write(TextWriter)` continues to stream one pass directly to the caller's writer.

## Evidence and limits

- Original revision: [`8165073a`](https://github.com/nextwebwg/html-next/commit/8165073ace16738617fcac6e706ddd981234f9c0). Candidate: [`9aa0f4d1`](https://github.com/nextwebwg/html-next/commit/9aa0f4d136d50bb996f56981722a054f1567546b). The intervening package branding commit changes no rendering source. Subsequent release metadata, documentation and test changes preserve the measured rendering source.
- Host: Apple M4 Pro, Arm64, macOS 27.2, .NET runtime 10.0.5, SDK 10.0.201. BenchmarkDotNet 0.15.8, Fluid 2.41.1 and AngleSharp 1.10.0.
- Protocol: three independent full runs per revision, each using ShortRun's three timed iterations. Runs were serial on the same shared machine. Selection used median aggregation and a 5% relative improvement threshold. Both required objectives improved, with no violated objective.
- Every benchmark setup compares complete outputs from both engines against an independently constructed expected string before timing. The unchanged cases include escaped text and attributes, numeric formatting, collection traversal and computed multiplication. Timing excludes template compilation and Fluid parsing.
- The original accepted baseline from an earlier session had a median total of 251.715 μs and worst ratio of 1.16071. It was repeated before implementation because the machine and measurement time had changed. The table uses the fresh original-to-candidate comparison.
- One experiment was tried and retained. The initial forecast was 25% to 40% less native rendering time against the earlier accepted baseline. The fresh comparison found 30.4%; these measurement sessions have different baselines, so the forecast and result are not a direct quantitative forecast test.
- The candidate passed all 2,301 existing native tests before timing. Release verification adds coverage for large concurrent renders, escaping and shorter subsequent output, plus the installed-package consumer and browser hydration checks.
- No held-out workload was configured. Selection and reporting use the same five fixed cases. No case failed output validation or regressed in rendering time. Cold requests, compilation, Windows, trimming, Native AOT, sustained server concurrency and complex component-graph performance remain unmeasured here.

The measured output pass was the selected cost to remove. A fresh profile would be needed to identify the next useful optimization; the original phase attribution does not establish a new bottleneck after this change.

## Reproduce

Run from the repository root, without overlapping local measurements:

```sh
corepack pnpm measure:dotnet --filter '*'
```

Repeat three times at each revision and retain the full JSON reports. The immutable workloads and independent output checks are in `packages/html-next-dotnet/benchmarks`. Machine-local raw reports, source identities, samples, forecasts and decisions are recorded under `.context/compound-engineering/ce-optimize/native-fluid/`; that directory is ignored by Git. This report carries the result with the source branch.

The optimization loop took 10 minutes 53 seconds, excluding publication and release checks. It stopped after one experiment because both approved targets were reached, within the four-experiment, one-active-hour and two-wall-hour limits. One experiment was kept, with zero reverted, inconclusive, censored, deferred, unselected, failed or timed-out experiments. No worker agents, judge calls or added dependencies were used. Monetary cost was not supplied by the host and is not estimated here. The local ledger records elapsed time and the complete samples.
