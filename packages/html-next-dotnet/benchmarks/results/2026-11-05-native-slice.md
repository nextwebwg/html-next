# Initial native template rendering measurements

For the current implementation, see the [low-memory measurements](2026-11-05-low-memory.md). This initial experiment is retained as the allocation baseline.

The experimental C# rendering slice used less rendering time than cached Fluid templates in all four workloads in two sequential runs. The reduction ranged from 11.4% to 32.1%. It allocated more memory in every case. These results qualify the current inert rendering experiment, not the complete component language or browser hydration.

The [machine-readable receipt](2026-11-05-native-slice.json) retains both runs' samples, confidence intervals, allocations, environment details, input/output hashes, the native source digest, and Node adapter measurements.

## Cached rendering

Each table cell gives the initial run followed by the confirmation run. Times are arithmetic means in microseconds per complete render, including fresh input binding and a returned HTML string.

| Workload | C# HTML Next, microseconds | Fluid, microseconds | Time reduction |
| --- | ---: | ---: | ---: |
| Card | 0.161 / 0.170 | 0.237 / 0.248 | 32.1% / 31.7% |
| 10 products | 1.573 / 1.838 | 2.151 / 2.372 | 26.9% / 22.5% |
| 100 products | 14.842 / 16.001 | 18.492 / 19.827 | 19.7% / 19.3% |
| 1,000 products | 176.684 / 192.261 | 216.866 / 217.110 | 18.5% / 11.4% |

| Workload | C# bytes allocated | Fluid bytes allocated |
| --- | ---: | ---: |
| Card | 848 | 704 |
| 10 products | 7,120 | 4,648 |
| 100 products | 60,256 | 37,770 |
| 1,000 products | 558,032 | 502,919 |

Allocation counts agreed between runs. The native binder normalizes records and lists into request-local arrays, preserving isolation but adding allocation cost. The larger list also allocates a large final string. Allocation reduction remains worthwhile follow-up work; these results do not establish behavior under sustained concurrent serving load.

## Conditions and validation

Measured 2026-11-05 on Apple M4 Pro, macOS 27.2, .NET SDK 10.0.201, .NET runtime 10.0.5, Fluid.Core 2.41.1, and BenchmarkDotNet 0.15.8. Each run used ShortRun: one process launch, three warmup iterations, and three measured iterations per case/method. Native plans and Fluid parsed templates were retained, and both sides used fresh request-local binding/context and full string output. Neither parsed its template in the timed render.

Before timing, both engines rendered the entire output and matched an independently constructed expectation. The Node adapter matched the same template, model, and output hashes. Fixtures contain escaping, conditional output, nested object reads, numeric output, and repeated rows. The benchmark validates exact bytes for these cases.

This is a short performance screen on a shared workstation. Priority elevation was unavailable. The second run changed absolute timings, particularly for the larger list; three iteration samples produce broad confidence intervals. Both passes favored the native slice, but they do not support a general ranking or precise latency guarantees. Reported percentiles describe iteration averages, not individual request latency.

## Node template/data-binding comparison

The Node adapter uses the production HTML Next parser, type checks, and expression evaluator, with a benchmark-only inert HTML writer. It parses once and measures repeated data binding and rendering with the same fixtures. Node 24.20.0 produced these medians of nine timed batch averages:

| Workload | Node adapter, microseconds |
| --- | ---: |
| Card | 0.534 |
| 10 products | 8.023 |
| 100 products | 79.059 |
| 1,000 products | 853.867 |

This adapter is neither the public worker/DOM renderer nor a generated Node SSR backend. It traverses different rendering machinery from the native plan, and its harness differs from BenchmarkDotNet. The table diagnoses the current implementations; it does not isolate the languages' intrinsic property-access cost or establish that C# is generally faster than Node. Node allocations, controlled cold-start costs, and matched HTTP/concurrency workloads remain unmeasured.

## Platform feasibility observations

The native tests preserve the browser-like inserted table body and SVG attribute casing in the cases examined. AngleSharp can discard unsupported children of a select before validation, so this slice diagnoses select elements.

A separate AngleSharp.Css 1.4.0-beta.416 probe dropped an unknown at-rule and a selector using `:state()` under default settings. Enabling preservation of unknown rules/declarations and tolerance of unknown selectors retained those constructs, while still normalizing color text. This library remains a candidate for further evaluation; it is not a production dependency of the rendering slice.

A currency probe found that .NET and Node Intl agree for the examined en-US USD value. For fr-FR EUR, .NET placed U+0020 before the currency symbol and Node placed U+00A0; both used U+202F for digit grouping. Native formatting therefore needs an explicit compatibility adapter and broader checks before equivalent server/browser text can be promised. No formatting adapter is part of this measurement.

## Reproduce

From the repository root, with .NET 10 and installed workspace dependencies:

```sh
corepack pnpm test:dotnet
corepack pnpm measure:dotnet --filter '*' --artifacts .context/dotnet-measurements
corepack pnpm measure:dotnet:node
```

Run timing commands sequentially after correctness/build work has finished. Compare full output/model/template hashes, preserve individual cases and allocation counts, and state the adapter and rendering obligations when comparing runtimes.
