---
title: Build components
order: 0
navGroup: guide
blurb: markup · state · events · bindings
eyebrow: HTML Next · Build
---

# Build an HTML Next component

Define a reactive counter in HTML. Choose a framework in any section; the rest of the page follows your choice. The component definition stays the same.

## Write the component

Save this as `counter.html`. It declares state and two click handlers, with native buttons for incrementing and resetting the count.

```html title="counter.html"
<template component="x-counter">
  <defs>
    <state name="count" type="number" value="0"></state>
    <handler name="increment">
      <set name="count" expr:value="count + 1"></set>
    </handler>
    <handler name="reset">
      <set name="count" expr:value="0"></set>
    </handler>
  </defs>
  <div>
    <button type="button" on:click="increment">
      Count: <span $value="count"></span>
    </button>
    <button type="button" on:click="reset">Reset</button>
  </div>
</template>
```

`$value` connects the span to `count`. The handlers update that state when either button is clicked. The rendered root is the `div` containing both buttons.

Add a `<style>` inside the definition when it needs scoped CSS. An optional `controller="./counter.js"` connects an ordinary ES module for imperative behavior. Start with the markup and add JavaScript where you need it.

::: framework-html-next

Use this HTML definition directly in the browser, or let Vite build native DOM factories.

:::

::: framework-vue

The Vue adapter turns this HTML definition into a Vue component when your app builds.

:::

::: framework-react

The React adapter turns this HTML definition into a React component when your app builds.

:::

::: framework-svelte

You can author this HTML definition now. The Svelte adapter is coming soon.

:::

## Use what you built

::: framework-html-next

[Set up HTML Next](/html-next/usage). Use Vite for a native app, or load the definition directly in an HTML page.

:::

::: framework-vue

[Set up Vue](/html-next/usage/vue). Import `XCounter` from `counter.html` and use it like another Vue component.

:::

::: framework-react

[Set up React](/html-next/usage/react). Import `XCounter` from `counter.html` and use it like another React component.

:::

::: framework-svelte

Svelte support is coming soon. [Use HTML Next today](/html-next/usage) or choose Vue or React above.

:::

## Keep learning

The [component model](/declarative-components/components), [bindings](/declarative-components/bindings), [reactivity](/declarative-components/reactivity), and [styles](/declarative-components/styling) are defined in the proposal. Use those chapters as the full authoring reference; use these guides for installation, integration, and distribution.
