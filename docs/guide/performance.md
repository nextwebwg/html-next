---
title: Performance
order: 6
navGroup: guide
blurb: benchmark tooling
eyebrow: HTML Next · Performance
---

# Performance

HTML Next includes tools for measuring rendering time and bundle size during development.

See the [benchmark harness documentation](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/framework-benchmark.md) for workloads, build options, and reproduction commands.

## How builds compile components {#compiled-output}

The Vite plugin and `html-next build` compile every component to plain JavaScript that creates and updates native DOM. No template interpreter, type parser or component parser ships to the browser, and there is no faster mode to switch on: this is the only build output.

- **Templates are cloned.** Each component's static markup is built once into a prototype and cloned for every instance, branch and list row.
- **Updates are direct.** Every binding knows which state it reads, and writes its element only when its converted text or value changes. A change to one state value touches only the bindings that read it.
- **Keyed lists move rows.** `$each` with `$key` keeps each row's element, moves only rows outside the longest stable run, and removes adjacent rows together. Selecting a row by key updates only the old and new rows.
- **Only what you use ships.** A component imports only the helpers its features need. Each prop and event type compiles to its own check, so a component with `keyword` props does not carry list, object or color parsing.
- **Behavior matches the browser runtime.** Compiled components give the same DOM, validity messages, warnings, controller host, lifecycle order and hydration as definitions loaded in the browser. The repository's parity tests hold the two to each other in Chromium, Firefox and WebKit.

The [compiled components reference](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/compiled-direct-path.md) describes the architecture and the size budgets.

