---
title: Navigation
order: 3
blurb: hk-nav · page order · labels
eyebrow: HTMLKit
---

# Navigation

`<hk-nav>` renders a list of links to your pages. It's built in, so you don't need to link it.
A layout loader asks for the pages, and the layout passes them in:

```ts
// app/layouts/default.server.ts
export async function load({ navigation }) {
  return { props: { pages: await navigation() } };
}
```

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <defs>
    <prop name="pages" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Site pages</prop>
  </defs>
  <aside><hk-nav from:items="$pages" label="Site"></hk-nav></aside>
  <main><slot name="page"></slot></main>
</template>
```

It renders an accessible `<nav>` of plain links with no styles of its own. The current page's link
has `aria-current="page"`, and each item has a `data-depth` you can indent with CSS.

## Ordering pages

Pages are listed alphabetically by URL. To choose the order, start file and folder names with a
number and a dot. The number sets the order and never appears in the URL:

```text
app/pages/
  index.html             /                  1st
  01.guide/
    index.html           /guide/            2nd
    01.install.html      /guide/install/    3rd
    02.deploy.html       /guide/deploy/     4th
  02.api.html            /api/              5th
  about.html             /about/            last: unnumbered pages follow numbered ones
```

Numbers compare as numbers, so `10.` comes after `02.`. Zero-padded names (`01.`, `02.`) also sort
correctly in your editor. A folder's own page comes before the pages inside it. A dash is part of a
name, not an order: `2024-recap.html` is `/2024-recap/`.

## Labels and hidden pages

A link's label is the last part of its URL, or "Home" for `/`. A page can choose its own, or stay
out of navigation while remaining a page:

```html
<template component="page-install">
  <meta name="hk:label" content="Installation">
  …
</template>

<template component="page-thanks">
  <meta name="hk:navigation" content="hidden">
  …
</template>
```

An `hk:alias` URL, such as `<meta name="hk:alias" content="/start/">`, opens the same page but never
gets its own link. Visiting it marks the page's own link as current.

## Breadcrumbs and previous/next links

`<hk-breadcrumbs>` shows the trail from the home page to the current page, and `<hk-pager>` links
the pages before and after it in navigation order. Both are built in, and their loader helpers sit
next to `navigation()`:

```ts
// app/layouts/default.server.ts
export async function load({ breadcrumbs, pager }) {
  return { props: { crumbs: await breadcrumbs(), ...await pager() } };   // pager() gives { previous, next }
}
```

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <defs>
    <prop name="crumbs" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Trail</prop>
    <prop name="previous" type="object({ href: string, label: string, current: string, depth: number, pageName: string })" nullable>Previous page</prop>
    <prop name="next" type="object({ href: string, label: string, current: string, depth: number, pageName: string })" nullable>Next page</prop>
  </defs>
  <main>
    <hk-breadcrumbs from:items="$crumbs"></hk-breadcrumbs>
    <slot name="page"></slot>
    <hk-pager from:previous="$previous" from:next="$next"></hk-pager>
  </main>
</template>
```

| Component | Renders |
| --- | --- |
| `<hk-breadcrumbs>` | `<nav aria-label="Breadcrumb">` with an ordered list of links. The last is the current page, with `aria-current="page"`. Only pages that exist appear, so a folder without an `index` page is skipped. |
| `<hk-pager>` | `<nav aria-label="Pages">` with `rel="prev"` and `rel="next"` links. Each starts with "Previous" or "Next", which `previous-text` and `next-text` change. A link is left out at either end. |

`breadcrumbs({ from })` starts the trail at a folder instead of the home page, and `pager({ from })`
moves only between the pages under it.

## Part of the site

`navigation({ from: '/guide/' })` lists only the pages under `/guide/`. Each item has:

| Field | Value |
| --- | --- |
| `href` | The page URL, including the site's base path. |
| `label` | The link text. |
| `current` | `"page"` for the page being rendered, otherwise `"false"`. |
| `depth` | How deep the page is below `from`. |
| `pageName` | The page's component name. |

Dynamic pages appear once per value their loader's `entries()` lists. Outside loaders,
`application.navigation({ from, current })` returns the same list.
