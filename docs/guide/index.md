---
title: HTML Next
order: -1
blurb: universal components · HTML, CSS, JavaScript
eyebrow: HTML Next
status: Open source · MIT licensed
pager: false
---

# Universal components. Built with HTML.

Build reactive components in HTML. Keep markup, state, and styles together, then use the same component natively or in Vue, React, Preact, Svelte, or Angular.

Conversion is tested against [Looma’s complete catalog](https://threadlabs.studio/looma/) and shared interaction tests in Chromium. [Parity checks](https://github.com/nextwebwg/html-next/actions/workflows/converter-corpus.yml) also compare behavior and rendering in Chromium, Firefox, and WebKit.

## Choose your tools

| You want to… | Start here |
| --- | --- |
| Build browser components with Vite | [Vite and browser](/html-next/usage) covers native DOM and framework imports through the Vite plugin. |
| Generate framework source with the converter | [Converter](/html-next/convert) generates Vue, React, Preact, Svelte or Angular files for your framework's build. |
| Render request data with C# | [C# quick start](/html-next/dotnet) installs the NuGet package and renders an ASP.NET response. Continue with [C# browser hydration](/html-next/dotnet-hydration) for interactive pages. |

New to the component language? [Build your first component](/html-next/quick-start). To distribute components, [publish HTML sources for Vite](/html-next/ship) or [publish generated framework packages](/html-next/ship-frameworks).

[Full-stack Node and C# examples](/html-next/full-stack) demonstrate the same component dataflow in both server hosts.

HTML Forms has its own [installation and usage guide](/html-next/forms).

See [Performance and size](/html-next/performance) for benchmark results and bundle measurements.

## Built on a public proposal

HTML Next provides JavaScript tooling and a native .NET initial renderer for the [Declarative HTML Components](/declarative-components/) and [HTML Forms](/html-forms/) proposals. The component language has one reference: the public proposal. These guides cover installing and using its implementations.

The tools are in early development and the proposals are at Stage 0. Syntax and generated output may change. Browsers do not support this component syntax on their own; HTML Next runs or builds the definitions for your project.

[Looma](https://threadlabs.studio/looma/) is a UI library authored with this component language. Explore the [tools source](https://github.com/nextwebwg/html-next), try a component, and [report what you find](https://github.com/nextwebwg/html-next/issues).
