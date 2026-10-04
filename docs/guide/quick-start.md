---
title: Build components
order: 0
navGroup: guide
blurb: markup · state · events · bindings
eyebrow: HTML Next · Build
---

# Build an HTML Next component

Define a reactive counter in HTML. Use the same component in an HTML page, a native Vite app, Vue, or React.

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

## Use what you built

[Use the component](/html-next/usage) with HTML Next. That guide starts with native Vite setup and includes a browser runtime option. Its switcher also covers Vue and React; Svelte support is coming soon.

## Keep learning

The [component model](/declarative-components/components), [bindings](/declarative-components/bindings), [reactivity](/declarative-components/reactivity), and [styles](/declarative-components/styling) are defined in the proposal. Use those chapters as the full authoring reference; use these guides for installation, integration, and distribution.
