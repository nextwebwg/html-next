---
title: HTML Next
order: -1
blurb: universal components · HTML, CSS, JavaScript
eyebrow: HTML Next
status: Open source · MIT licensed
pager: false
---

# Universal components. Built with HTML.

Build reactive components in HTML. Keep markup, state, and styles together, then use the same component natively, in Vue, or in React. Svelte support is coming soon.

## What is HTML Next?

HTML Next is a component format and JavaScript tools for building reactive interfaces with HTML. A definition brings markup, state, events, slots, and scoped styles together in one file. Use it natively in an HTML page or with Vite, or import it into Vue and React through their adapters.

The tools implement a public proposal today. Browsers do not support this component syntax on their own; HTML Next runs or builds the definitions for your project.

## Why build components this way?

A reusable component should not need a rewrite every time an application changes frameworks. HTML Next keeps the source in HTML and lets the consuming project choose how to use it. That is useful for component libraries shared by HTML pages, Vue apps, and React apps.

| Approach | How you build | Where it fits |
| --- | --- | --- |
| HTML and JavaScript | Write markup and manage behavior with browser APIs. | Pages and interactions where direct control is enough. |
| HTML Next components | Declare the component's interface, state, and bindings in HTML. | Reactive components you want to use natively or share across frameworks. |
| Framework components | Use Vue, React, or another framework's own component format. | Applications and libraries built around that framework's conventions and ecosystem. |

Use HTML Next when you want one component library to serve several application stacks. Framework-specific components fit projects that depend on features or libraries tied to that framework. HTML Next's adapters generate framework output from your HTML definitions.

## Build a component. Use it in your project.

[Build your first component](/html-next/quick-start) with a short HTML file. Then follow [Usage](/html-next/usage) to install and render it. HTML Next is the default; Vue and React have their own setup in the same guide.

::: targets
[Use HTML Next](/html-next/usage)
: Use HTML Next natively with Vite, or load definitions directly in an HTML page.

[Use with Vue](/html-next/usage/vue)
: Import HTML components alongside your Vue components with the Vite adapter.

[Use with React](/html-next/usage/react)
: Import HTML components alongside your React components with the Vite adapter.
:::

## Find your path

| You want to… | Start here |
| --- | --- |
| Learn to author HTML Next components | [Build your first component](/html-next/quick-start), then [use it natively](/html-next/usage). |
| Use components in an existing app | [Usage](/html-next/usage) starts with HTML Next and has Vue and React setup in its switcher. |
| Publish a component library | [Publish your HTML files](/html-next/ship) with instructions for the consuming app’s Vite plugin. |
| Generate framework source files | The separate [Converter](/html-next/convert) covers conversion commands and their output. |

HTML Forms has its own [installation and usage guide](/html-next/forms).

## Built on a public proposal

HTML Next is JavaScript tooling for the [Declarative HTML Components](/declarative-components/) and [HTML Forms](/html-forms/) proposals. The component language has one reference: the public proposal. These guides cover installing and using its implementation.

> [!note] Early, and usable today
> The tools are in early development and the proposals are at Stage 0. Syntax and generated output may change. Vue and React adapters and converters are available; Svelte adapters and conversion are planned and do not ship yet.

[Looma](https://threadlabs.studio/looma/) is a UI library authored with this component language. Explore the [tools source](https://github.com/nextwebwg/html-next), try a component, and [report what you find](https://github.com/nextwebwg/html-next/issues).
