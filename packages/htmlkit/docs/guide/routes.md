---
title: Pages and routing
order: 1
blurb: file routes · dynamic pages · layouts · page head
eyebrow: HTMLKit
---

# Pages and routing

Every file in `app/pages` is a page, and its path is its URL:

| File | URL |
| --- | --- |
| `app/pages/index.html` | `/` |
| `app/pages/about.html` | `/about/` |
| `app/pages/blog/index.html` | `/blog/` |
| `app/pages/blog/first-post.html` | `/blog/first-post/` |
| `app/pages/blog/[slug].html` | `/blog/anything/` (one page per value) |

A few rules cover the rest:

- `index.html` is its folder's page.
- URLs end with a slash; HTMLKit redirects `/about` to `/about/`.
- Files and folders starting with `_` or `.` are not pages, so keep helpers there or in `app/components`.
- A number and a dot at the start of a name, as in `01.guide/`, orders [navigation](/htmlkit/navigation)
  and never appears in the URL.

## A page

A page is an HTML Next component. Its `<title>` and `<meta>` tags go in the page's `<head>`:

```html
<!-- app/pages/about.html -->
<template component="page-about">
  <title>About us</title>
  <meta name="description" content="Who we are.">
  <main>
    <h1>About us</h1>
  </main>
</template>
```

Component names must be unique across the site. A `page-` prefix keeps them apart from your other
components.

If a file declares more than one component, say which one is the page:

```html
<meta name="hk:page" content="page-about">
<template component="team-card">…</template>
<template component="page-about">…</template>
```

## Dynamic pages

A name in brackets matches any single URL segment. Its value reaches the page through a
[loader](/htmlkit/loaders), which also lists the pages to build:

```text
app/pages/blog/[slug].html        /blog/first-post/, /blog/second-post/, …
app/pages/blog/[slug].server.ts   loads each post and lists the slugs
```

```ts
// app/pages/blog/[slug].server.ts
export const entries = () => [{ slug: 'first-post' }, { slug: 'second-post' }];

export function load({ params }) {
  return { props: { title: `Post ${params.slug}` } };
}
```

When a literal page and a dynamic one could both match, the literal page wins.

## Layouts

A layout wraps pages. `app/layouts/default.html` wraps every page automatically; the page appears
where the layout puts `<slot name="page">`:

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <title>My site</title>
  <header>My site</header>
  <main><slot name="page"></slot></main>
</template>
```

To use another layout for one page, name it; `content="none"` uses no layout:

```html
<template component="page-dashboard">
  <meta name="hk:layout" content="admin">   <!-- app/layouts/admin.html -->
  <h1>Dashboard</h1>
</template>
```

To give a whole folder a layout, see `layoutDefaults` in [Configuration](/htmlkit/configuration).

## The page head

`<title>`, `<meta>`, and `<link>` tags directly inside a page or layout component go in the document
head. A page's `<title>` and `<meta>` tags replace the layout's; stylesheet and alternate `<link>`s from
both are kept. They can use the page's props:

```html
<template component="page-post">
  <title>{$title}</title>
  <meta name="description" from:content="$summary">
  <defs>
    <prop name="title" type="string" required>Post title</prop>
    <prop name="summary" type="string" required>Post summary</prop>
  </defs>
  <article><h1>{$title}</h1></article>
</template>
```

A loader can also set `head: { title, description, lang }`.

Settings that start with `hk:` configure HTMLKit and never reach the page:

| Metadata | Does |
| --- | --- |
| `hk:page` | Chooses the page component in a file with several components. Goes outside the components. |
| `hk:layout` | Chooses a layout, or `none`. |
| `hk:label` | Sets the page's label in [navigation](/htmlkit/navigation). |
| `hk:navigation` | `content="hidden"` keeps the page out of navigation. |
| `hk:alias` | Adds another URL for the page, such as `content="/start/"`. |

## A script before first paint

`app/head.js` runs in every page's head before anything is drawn, which is how a site applies a
saved dark theme without a flash. Keep it small, because it delays the first paint:

```js
// app/head.js
document.documentElement.dataset.theme = localStorage.getItem('theme') ?? 'light';
```

It cannot contain `<!--`, `<script`, or `</script`. If the site has a Content Security Policy,
allow it with a `'sha256-…'` hash of its text.

## Details

- Two files that produce the same URL are an error that names both files.
- Literal URL segments take priority over parameters. Optional and catch-all parameters are not
  supported yet.
- Pages, layouts, and components link other components with
  `<link rel="component" href="…">`. `@/` is the project root, so
  `href="@/components/card.html"` works from anywhere.
- Outside HTMLKit, the regular HTML Next loader ignores page metadata, so the same component files
  still work there.
