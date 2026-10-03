---
title: HTML Next
order: -1
blurb: universal components · HTML, CSS, JavaScript
eyebrow: HTML Next
status: Open source · MIT licensed
pager: false
---

# Universal components. Built with HTML.

Build reactive components using the next generation of HTML. Author once, run them in the browser, or bring them to Vue and React. Svelte support is coming soon.

## One component, more places to use it

Your components belong to your library, not to one application stack. HTML Next gives an HTML definition state, computed values, events, slots, and scoped styles, then delivers it in the form your project needs.

::: targets
HTML you can read
: Define the interface and markup together. Add ordinary JavaScript when a component needs it.

Reactivity you can declare
: Connect state, values, and events in the component. Let the tools handle updates.

Output you can own
: Ship native DOM or framework source. Inspect the generated code and keep using your usual build tools.
:::

## Choose how to use it

::: targets
[Use Vue or React](/html-next/frameworks)
: Add the Vite adapter and import HTML components alongside your existing components. Both adapters and converters are available today; Svelte is coming soon.

[Run directly in the browser](/html-next/runtime)
: Add one module script and link your component. The live runtime discovers and updates instances, with no build step.

[Compile to native DOM](/html-next/build)
: Build a known application or library graph with Vite. Component parsing stays out of the browser bundle.
:::

## Start small. Ship something reusable.

[Build your first component](/html-next/quick-start) with a short HTML file. Use the same definition in a page, a Vue project, or a React project. When it is ready to share, [ship an HTML source library](/html-next/ship) or [convert it ahead of time](/html-next/convert).

```bash
npm install @nextwebwg/html-next
```

For Vue and React projects, add the [Vite adapter](/html-next/frameworks). For generated framework source, use the [converter](/html-next/convert). HTML Forms is available as an [independent subpath](/html-next/forms).

## Built on a public proposal

HTML Next is JavaScript tooling for the [Declarative HTML Components](/declarative-components/) and [HTML Forms](/html-forms/) proposals. The component language has one reference: the public proposal. These guides cover installing and using its implementation.

> [!note] Early, and usable today
> The tools are in early development and the proposals are at Stage 0. Syntax and generated output may change. Vue and React adapters and converters are available; Svelte adapters and conversion are planned and do not ship yet.

[Looma](https://threadlabs.studio/looma/) is a UI library authored with this component language. Explore the [tools source](https://github.com/nextwebwg/html-next), try a component, and [report what you find](https://github.com/nextwebwg/html-next/issues).
