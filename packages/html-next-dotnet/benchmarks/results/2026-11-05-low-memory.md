# Low-allocation native rendering measurements

The native rendering slice now allocates 65-72% fewer bytes per render than its original implementation and 49-66% fewer than cached Fluid templates in these four workloads. Allocation counts agreed between two BenchmarkDotNet runs. Native mean render times remained below Fluid in both runs, though timing was noisy.

The [machine-readable receipt](2026-11-05-low-memory.json) retains samples, confidence intervals, allocation attribution, source identity, and full template/model/output hashes. The [original receipt](2026-11-05-native-slice.json) remains the allocation baseline. These are measurements of the experimental inert template/data-binding slice.

## Allocated bytes per complete render

Both sides retain compiled templates, bind fresh request inputs, and return a complete HTML string. Neither reparses its template during the measured render.

| Workload | Original C# | Current C# | Fluid | Reduction from original C# | Below Fluid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Card | 848 B | 240 B | 704 B | 71.7% | 65.9% |
| 10 products | 7,120 B | 1,984 B | 4,648 B | 72.1% | 57.3% |
| 100 products | 60,256 B | 19,264 B | 37,770 B | 68.0% | 49.0% |
| 1,000 products | 558,032 B | 195,728 B | 502,919 B | 64.9% | 61.1% |

These figures count bytes allocated during execution. They do not measure peak process RAM or retained heap size.

## Binding versus output

An allocation observer captures the current thread's allocated-byte count immediately before the first output write. The native renderer completes input binding before that write, so this separates normalization from output work. Each result is the mean of 200 warmed calls; the observer and delegates are constructed outside the measured region.

| Workload | Original binding allocations | Current binding allocations |
| --- | ---: | ---: |
| Card | 64 B | 64 B |
| 10 products | 2,984 B | 784 B |
| 100 products | 27,888 B | 7,264 B |
| 1,000 products | 272,696 B | 72,064 B |

The small card's excess came from output construction rather than binding. Larger lists also paid for per-row diagnostic strings, redundant numeric boxes, and intermediate collection buffers. Fluid binds while rendering, so its first output write does not define an equivalent binding boundary; its complete-render allocation is the fair comparison above.

The current native writer-only path allocated the same number of bytes as binding in these fixtures: formatting and emission added no managed allocations in the observer. Returning a string then added the final string itself. For 1,000 rows, the warm attribution measured 72,064 B for binding plus 123,600 B for the returned UTF-16 string. The two measurement methods differ by 64 B for this case; the complete-render table uses BenchmarkDotNet's measurements.

## Implementation

Diagnostic paths are computed when a prop's type is compiled. Reference and JSON arrays normalize directly into exact-size request snapshots, and existing finite double boxes are reused. Numeric serialization formats into stack spans.

`Render` binds once, counts output over the accepted snapshot, and fills one exact-size string. It adds a counting pass over pure rendering operations without rereading application getters or enumerating application data again. `Write` emits directly to a supplied writer in one output pass. Neither path retains pooled output buffers between requests.

Request-local snapshots remain in place for isolation and stable data. This change removes temporary work around them rather than sharing mutable bound values between requests.

## Rendering time

Each cell shows the initial low-memory run followed by its confirmation. Times are arithmetic means in microseconds per complete string render.

| Workload | C# | Fluid |
| --- | ---: | ---: |
| Card | 0.196 / 0.216 | 0.310 / 0.366 |
| 10 products | 1.842 / 2.640 | 3.498 / 3.441 |
| 100 products | 21.202 / 24.531 | 23.408 / 29.192 |
| 1,000 products | 269.454 / 282.242 | 385.350 / 380.138 |

Each sweep used BenchmarkDotNet 0.15.8 ShortRun: one launch, three warmup iterations, and three measured iterations per method/case. Environment: Apple M4 Pro, macOS 27.2, .NET SDK 10.0.201, .NET 10.0.5, and Fluid.Core 2.41.1. Priority elevation was unavailable on this shared workstation.

Timing variance and confidence intervals were large. These results support keeping the allocation reduction with favorable mean ordering against Fluid; they do not establish a precise speedup, an improvement over earlier C# timings, or a latency guarantee. The counting pass exchanges some execution work for lower allocation. Output and data hashes match the original experiment exactly.

## Verification and reproduction

`pnpm verify:pr` passed, including 1,499 JavaScript tests, 24 native tests, and 8 packed-consumer tests. The additional native checks cover Unicode sizing, getter reads, JSON arrays, diagnostic paths, and numeric serialization boundaries. Existing concurrency, one-shot enumeration, cancellation, escaping, and writer equivalence checks remain passing. The root Node gate skips its browser/target suites; this slice adds no browser output.

From the repository root:

```sh
corepack pnpm test:dotnet
corepack pnpm measure:dotnet --allocations
corepack pnpm measure:dotnet --filter '*' --artifacts .context/dotnet-memory-measurements
```

Run timed sweeps sequentially after builds and correctness checks finish. Peak working set, sustained concurrent serving, full component behavior, and hydration remain outside these measurements.
