---
title: Performance
order: 6
navGroup: guide
blurb: rendering speed · bundle size · measured results
eyebrow: HTML Next · Performance
---

# Beats Solid, Svelte, Vue, and React in js-framework-benchmark.

HTML Next wins the overall rendering comparison against all four frameworks in two full runs of the keyed benchmark.

## Rendering speed

| Framework | HTML Next / framework, run 1 | HTML Next / framework, run 2 | Less time overall |
| --- | ---: | ---: | ---: |
| Solid 1.9.3 | 0.988 | 0.982 | **1.5%** |
| Svelte 5.42.1 | 0.963 | 0.958 | **3.9%** |
| Vue 3.5.39 | 0.874 | 0.868 | **12.9%** |
| React Hooks 19.2.0 | 0.742 | 0.734 | **26.2%** |

A ratio below 1 means HTML Next takes less time. Each run scores the weighted geometric mean of median total durations across all nine keyed workloads: create, replace, update, select, swap, remove, create 10,000 rows, append, and clear. The percentage column summarizes the two run ratios using their median.

These are overall scores; the raw results show each workload separately.

## Bundle size

**HTML Next's benchmark bundle is 23% smaller than Svelte's.**

| Production benchmark app | gzip bytes | kB |
| --- | ---: | ---: |
| HTML Next | **8,281** | **8.28** |
| Svelte | 10,722 | 10.72 |

Both measurements include the application and its tree-shaken runtime, compressed at gzip level 6. They measure the code needed for this benchmark, rather than an isolated runtime package. The build-free HTML Next browser runtime is a separate delivery option; its benchmark bundle measures 55,717 gzip bytes.

## Build the same way

HTML Next uses the native Vite build with direct DOM generation enabled:

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/app.html"],
    experimentalDirectExtend: true,
  })],
});
```

The `directExtend` field in `html-next.manifest.json` reports whether the optimization applies. The benchmark manifest records `applied: true` with no runtime component fallbacks. All compared framework entries use their production builds.

[Set up a native application →](/html-next/usage)

## Measurements and reproduction

Measured October 7, 2026 on an Apple M4 Pro running macOS 26.5.2, Chrome for Testing 153.0.8010.12, and Node 24.20.0. Each run uses the full standard sample counts: 15 CPU samples, and 25 for selection.

The harness pins [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) through the [Next Web WG fork at revision `1c5c091`](https://github.com/nextwebwg/js-framework-benchmark/tree/1c5c091eb0dbc2316f4ad3b23658fe2be617747e). It runs HTML Next, its browser runtime, vanilla JavaScript, and all four framework controls across all nine workloads.

- [Run 1: raw results](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/benchmarks/framework-results/20261007T053217Z-71ed537.json)
- [Run 2: raw results](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/benchmarks/framework-results/20261007T055730Z-71ed537.json)
- [Harness and reproduction commands](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/framework-benchmark.md)
- [Implementation and measurement history](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/rendering-performance-status.md)

The measured HTML Next artifact has SHA-256 `6153a30c86edbf3c689eef795de8357fd78da01adf2fde9855e27af82a2e44d4`. Its implementation was merged in [pull request #159](https://github.com/nextwebwg/html-next/pull/159).
