---
title: Transitions
order: 8
blurb: animate what $if and $each add, remove and move · an optional extension
eyebrow: HTML Next · Extensions
---

# Transitions

**Animate what your templates add, remove and reorder, without writing animation code.** The `transitions` [extension](/html-next/versions#extensions) runs each such update inside the browser's View Transitions API. An element that appears plays its keyframes, one that leaves plays them in reverse, and rows that move glide to their new places. You never call `startViewTransition()` or write `::view-transition-*` rules.

> [!warn] Optional, and built only by the Vite plugin
> The html-next Vite plugin builds `transitions` when you enable it. The live browser runtime and Vue, React and Svelte conversion do not support it: they build your components without animation and warn that they did.

## Enable it

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/components/app.html"],
    extensions: ["transitions"],
  })],
});
```

Without the option, a component that uses the directives fails with `HT024`, which names the option to add. `html-next-check` takes the same setting as `--extension transitions`.

## Animate an element

```html
<aside $if="$open" $transition="fly 200ms ease-out">…</aside>
```

`$transition` is written like CSS's `animation` shorthand: a keyframes name, then an optional duration, easing and delay. The keyframes describe the element arriving; leaving plays them in reverse. Use a built-in (`fade`, `fly`, `scale` or `blur`) or any `@keyframes` your styles define:

```html
<p $if="$saved" $transition="pop 150ms">Saved</p>

<style>
  @keyframes pop { from { scale: .5; opacity: 0; } }
</style>
```

An empty `$transition` keeps the browser's default crossfade.

## Animate a list

Put `$transition` on keyed rows. Rows that arrive or leave play their keyframes, and rows that move glide to their new places with the value's timing.

```html
<li $each="todo of $todos" $key="$todo.id" $transition="fade">{$todo.title}</li>
```

## Morph one element into another

`$transition-name` gives an element an identity across a change, as CSS's `view-transition-name` does. When one element leaves and another with the same name arrives in the same update, the browser moves and resizes the first into the second:

```html
<img $each="photo of $photos" $key="$photo.id" $transition-name="$photo.id">
<img $if="$selected" class="hero" $transition-name="$selected.id">
```

Names apply across the whole page, so the two elements can belong to different components. Any value works, and it is escaped for you. Only one element may hold a name at a time: two at once cancel the transition.

## What animates

- An update animates only when an `$if`, `$each` or `$match` adds, removes or reorders an element that carries one of the directives, at any depth inside it. Every other update applies at once.
- Updates from several components in the same task share one transition. They wait one frame, while the browser captures the page as it was.
- The rest of the page stays live and clickable while elements animate.
- When the user asks for reduced motion, updates apply at once.
- A component without the directives compiles exactly as it would without the extension, and pays nothing for it.

## Limits

- A transition that starts while another runs skips the first, so a quick close and reopen jumps instead of reversing.
- When a sibling leaves, content without a directive moves to its new place at once. Give it `$transition` to make it glide.
- A leaving element can draw outside an `overflow` container until element-scoped view transitions ship beyond Chromium.

Next: [Versions and stability](/html-next/versions#extensions) lists which tools build each extension, and the proposal's [transitions extension](https://nextwebwg.org/declarative-components/templating#transitions-extension) is its specification.
