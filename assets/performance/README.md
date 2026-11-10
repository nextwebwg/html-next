# Performance charts

The charts are generated from checked-in benchmark receipts. Both the site guide and the
npm README reference the same framework speed and size SVG. The NuGet README and site use
the same C# versus Fluid SVG.

- `native-fluid-2026-11-10.svg`: five warm, retained-template cases. Three independent
  BenchmarkDotNet ShortRun sweeps per source revision, with complete expected-output
  validation before timing. [Data](../../packages/html-next-dotnet/benchmarks/results/2026-11-10-single-pass.json)
  and [method and limits](../../docs/optimize/native-fluid-report.md).
- `frameworks-speed-size-2026-11-10.svg`: one full standard run of the pinned
  js-framework-benchmark fork, with all seven entries and nine keyed workloads. The
  [performance guide](../../docs/guide/performance.md) links the precise measurement receipt.
  Size includes the benchmark application's used runtime and application JavaScript,
  compressed per file at gzip level 6.

To regenerate, create a temporary Python environment with Matplotlib 3.11.2 and run from
the repository root:

```sh
python scripts/generate-performance-charts.py \
  --native packages/html-next-dotnet/benchmarks/results/2026-11-10-single-pass.json \
  --frameworks packages/html-next/benchmarks/framework-results/<measurement>.json
```

The generator embeds the official HTML Next mark and accessible SVG title/description.
Measurements cover different phases: the native chart measures inert server template
rendering; the framework chart measures browser updates. Neither establishes full-stack
HTTP throughput, hydration speed or a universal ranking for other applications.
