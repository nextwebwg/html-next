---
title: Navigation
order: 5
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
    <prop name="pages" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string, group?: string, ... }))" required>Site pages</prop>
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

A page can also set its number with `hk:order`, which is how a page format such as Markdown passes
on an order from its front matter. The number takes the place of the file name's own prefix, and
compares with its neighbours' prefixes as one, so this page sorts as `03.about.html` would:

```html
<template component="page-about">
  <defs><meta name="hk:order" content="3"></defs>
  …
</template>
```

`hk:order` orders a page among the pages in its folder. A folder's `index.html` comes first in its
folder, so on an index page, `hk:order` orders the whole folder among its neighbours, in place of
the folder's own prefix: `hk:order` 5 on `guide/index.html` sorts `guide/` as `05.guide/` would.
The site's home page has no folder to order, so `hk:order` there is an error.

## Groups

A [route group](/htmlkit/routes#route-groups), such as `01.(Getting started)/`, keeps its pages
together in navigation, and their URLs skip it. Its number orders it among the pages and
folders beside it, as for any folder, and its pages keep their own order inside it:

```text
app/pages/docs/
  index.html                  /docs/           1st
  01.(Getting started)/
    01.intro.html             /docs/intro/     2nd, group "Getting started"
    02.setup.html             /docs/setup/     3rd, group "Getting started"
  02.(Reference)/
    api.html                  /docs/api/       4th, group "Reference"
  faq.html                    /docs/faq/       last
```

Each navigation item in a group has a `group` field with the group's label. `<hk-nav>` shows the
label as a list item, with a `data-group` attribute, before the group's first link, so a sidebar can
style it as a heading:

```html
<li data-group="" data-depth="1">Getting started</li>
<li data-depth="1"><a href="/docs/intro/" aria-current="false">intro</a></li>
```

For nested groups, `group` is the innermost label; each route's `groups` (from `createApplication`
or `discoverRoutes`) lists them all, outermost first, with their order and depth.

## Declaring navigation props

A layout passes navigation items through its own props, as in the examples on this page. Declare
them with an open object type, which ends in `...`, so the props accept every field an item has,
including `group` and fields a later release adds:

```text
object({ href: string, label: string, current: string, depth: number, pageName: string, group?: string, ... })
```

`<hk-nav>`, `<hk-breadcrumbs>`, and `<hk-pager>` declare their items this way.

## Labels and hidden pages

A link's label is the last part of its URL, or "Home" for `/`. A page can choose its own, or stay
out of navigation while remaining a page:

```html
<template component="page-install">
  <defs><meta name="hk:label" content="Installation"></defs>
  …
</template>

<template component="page-thanks">
  <defs><meta name="hk:navigation" content="hidden"></defs>
  …
</template>
```

An `hk:alias` URL, such as `<meta name="hk:alias" content="/start/">`, opens the same page but never
gets its own link. Visiting it marks the page's own link as current.

## A navigation tree

`navigationTree()` returns the same pages as `navigation()`, in the same order, nested by folder and
[group](#groups). `<hk-nav>` renders it as nested lists, with each folder and group in a native
`<details>` element that is open when it holds the current page:

```ts
// app/layouts/default.server.ts
export async function load({ navigationTree }) {
  return { props: { pages: await navigationTree() } };
}
```

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <defs>
    <prop name="pages" type="list(object({ label: string, current: string, depth: number, ... }))" required>Site pages</prop>
  </defs>
  <aside><hk-nav from:items="$pages" label="Site"></hk-nav></aside>
  <main><slot name="page"></slot></main>
</template>
```

For `01.guide/index.html` (titled "The guide"), `01.guide/01.install.html`, and `01.guide/02.(Advanced)/tuning.html`, while
`/guide/tuning/` is the current page, the guide's node is:

```json
{
  "label": "The guide", "href": "/guide/", "pageName": "page-guide",
  "current": "false", "open": true, "depth": 0, "order": "01",
  "children": [
    { "label": "install", "href": "/guide/install/", "pageName": "page-install",
      "current": "false", "open": false, "depth": 1, "order": "01", "children": [] },
    { "label": "Advanced", "current": "false", "open": true, "depth": 1, "order": "02",
      "children": [
        { "label": "tuning", "href": "/guide/tuning/", "pageName": "page-tuning",
          "current": "page", "open": true, "depth": 2, "order": null, "children": [] }
      ] }
  ]
}
```

| Field | Value |
| --- | --- |
| `label` | A page's label. A folder's is its index page's `hk:label`, then its static `<title>`, then the folder name; a group's is the text in its parentheses. |
| `href`, `pageName` | The page's URL and component name, on a page or a folder with an index page. |
| `current` | `"page"` for the page being rendered, otherwise `"false"`. |
| `open` | `true` when the node or a node inside it is the current page. |
| `depth` | The nesting level, `0` at the top. |
| `order` | The node's number-and-dot prefix or `hk:order`, or `null`. |
| `children` | The pages, folders, and groups inside it, in navigation order. |

A folder with an index page is that page's node, and its summary links to the page. `from` gives the
tree under a folder, with the folder's own index page first. `<hk-nav>` also takes `navigation()`'s
flat list, which it renders as one list. `pager()` follows the same order, so the
previous and next links walk the tree from top to bottom.

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
    <prop name="crumbs" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string, group?: string, ... }))" required>Trail</prop>
    <prop name="previous" type="object({ href: string, label: string, current: string, depth: number, pageName: string, group?: string, ... })">Previous page</prop>
    <prop name="next" type="object({ href: string, label: string, current: string, depth: number, pageName: string, group?: string, ... })">Next page</prop>
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
| `group` | On a page in a [group](#groups), the label of the innermost group holding it. |

Dynamic pages appear once per value their loader's `entries()` lists. Outside loaders,
`application.navigation({ from, current })` returns the same list.
