---
title: Ordered routes and navigation
order: 3
blurb: ordered file routes · navigation
eyebrow: HTMLKit
---

# Ordered routes and navigation

Put a number and a dot before a file or directory name to order it in navigation. For example,
`app/pages/01.guide/02.install.html` becomes `/guide/install/`, and `01.index.html` becomes its
directory's landing page; the number never appears in the URL. A dash is part of a name, so
`2024-recap.html` stays `/2024-recap/`. Prefixes sort numerically (1, 2, 10); unprefixed siblings follow
prefixed siblings. Directory landing pages precede their descendants. Numeric ties use the URL
as a deterministic tie-breaker. Empty stripped segments and URL collisions are errors naming
the physical sources. Registered route patterns keep their authored URLs. The default is false.

Navigation contains only concrete routes, including aliases and enumerated dynamic entries.
Unenumerated dynamic patterns are omitted; static builds still require their `entries()`.
A loader can query a subtree using an application-relative prefix; hrefs include the deployment base:

```ts
import type { LoadContext } from '@nextwebwg/htmlkit';

export async function load({ navigation }: LoadContext) {
  return { props: { navigation: await navigation({ from: '/guide/' }) } };
}
```

`<hk-nav>` is built in, so it needs no component link:

```html
<template component="site-shell">
  <defs>
    <prop name="navigation" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop>
  </defs>
  <main>
    <hk-nav from:items="$navigation" label="Guide"></hk-nav>
    <slot name="page"></slot>
  </main>
</template>
```

Each item has `href`, a `label`, `current` (`page` or `false` for `aria-current`), `depth`
relative to the selected subtree, and `pageName`. A page sets its label with
`<meta name="hk:label" content="Install">`; otherwise the label is the final URL segment
(Home at the root). `<meta name="hk:navigation" content="hidden">` keeps a routable page out of
navigation, and alias routes (`hk:alias`) never appear; visiting an alias marks its page's own
entry current. Further policy can still be applied in the loader. The component
renders native anchors in a flat list with `data-depth` on each item; it adds no controller or theme.

`application.navigation({ from, current })` is also available outside loaders. `from` defaults
to `/`; `current` is a deployment pathname and defaults to the current page inside a loader.
Static entries are materialized once per application so rendering and navigation use the same catalog.

Next: [Configuration and API](/htmlkit/configuration).
