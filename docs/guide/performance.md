---
title: Performance
order: 6
navGroup: guide
blurb: rendering speed · bundle size · measured results
eyebrow: HTML Next · Performance
---

# Beats Solid, Svelte, Vue, and React in js-framework-benchmark.

A default HTML Next Vite build takes less time overall than all four frameworks across the nine keyed rendering workloads.

## Rendering speed

| Framework | HTML Next / framework | Less time overall |
| --- | ---: | ---: |
| Solid 1.9.3 | 0.936 | **6.4%** |
| Svelte 5.42.1 | 0.920 | **8.0%** |
| Vue 3.5.39 | 0.861 | **13.9%** |
| React Hooks 19.2.0 | 0.711 | **28.9%** |

A ratio below 1 means HTML Next takes less time. The score is the weighted geometric mean of median total durations across all nine keyed workloads: create, replace, update, select, swap, remove, create 10,000 rows, append, and clear.

These are overall scores. HTML Next is not faster in every workload: against Solid it takes longer to remove one row (10%), create 1,000 rows (4%) and append 1,000 rows (2%), and less time in the other six. The raw results show each workload.

## Bundle size

| Production benchmark app | gzip bytes |
| --- | ---: |
| Solid | 4,812 |
| **HTML Next** | **8,862** |
| Svelte | 10,722 |
| Vue | 25,963 |
| React Hooks | 61,343 |

Each measurement is the application with its tree-shaken runtime, compressed at gzip level 6: the code this benchmark needs, not an isolated runtime package. HTML Next's build-free browser runtime is a separate delivery option; its benchmark bundle measures 57,249 gzip bytes.

## Build the same way

The benchmark uses the default Vite setup, with no options beyond the entry file:

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/app.html"] })],
});
```

Every build compiles this way; there is no faster mode to switch on. The framework entries use their production builds.

[Set up a native application →](/html-next/usage)

## Measurements and reproduction

Measured October 8, 2026 on an Apple M4 Pro running macOS 26.5.2, Chrome for Testing 153.0.8010.12 and Node 24, in one full run with the standard sample counts: 15 CPU samples, and 25 for selection. The machine was idle apart from the benchmark.

The harness pins [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) through the [Next Web WG fork at revision `1ff9927`](https://github.com/nextwebwg/js-framework-benchmark/tree/1ff9927d4cb4dcc2a3e37c1adf8d993f64f4e92a). It runs HTML Next, its browser runtime, vanilla JavaScript, and all four framework controls across all nine workloads.

- [Raw results](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/benchmarks/framework-results/20261008T013021Z-5851b6e.json)
- [Harness and reproduction commands](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/framework-benchmark.md)
- [Implementation and measurement history](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/rendering-performance-status.md)

The measured HTML Next artifact has SHA-256 `ab245c7054ada544fa4cf237b8a77f9cf5bf15ec7e6116e1206f1c6c18b0d1cb`, built from commit [`5851b6e`](https://github.com/nextwebwg/html-next/commit/5851b6e29e2e493a70e00d1085ef90fec8bc4f46), which is release 1.0.0-alpha.34.

## How builds compile components {#compiled-output}

The Vite plugin and `html-next build` compile every component to plain JavaScript that creates and updates native DOM. No template interpreter, type parser or component parser ships to the browser, and there is no faster mode to switch on: this is the only build output.

- **Templates are cloned.** Each component's static markup is built once into a prototype and cloned for every instance, branch and list row.
- **Updates are direct.** Every binding knows which state it reads, and writes its element only when its converted text or value changes. A change to one state value touches only the bindings that read it.
- **Keyed lists move rows.** `$each` with `$key` keeps each row's element, moves only rows outside the longest stable run, and removes adjacent rows together. Selecting a row by key updates only the old and new rows.
- **Only what you use ships.** A component imports only the helpers its features need. Each prop and event type compiles to its own check, so a component with `keyword` props does not carry list, object or color parsing.
- **Behavior matches the browser runtime.** Compiled components give the same DOM, validity messages, warnings, controller host, lifecycle order and hydration as definitions loaded in the browser. The repository's parity tests hold the two to each other in Chromium, Firefox and WebKit.

The [compiled components reference](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/compiled-direct-path.md) describes the architecture and the size budgets.

