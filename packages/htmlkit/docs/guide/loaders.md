---
title: Loading data
order: 2
blurb: loaders · props · what reaches the browser
eyebrow: HTMLKit
---

# Loading data

Put a `.server.ts` file next to a page with the same name. Its `load()` runs at build time (and on
each request in development) and returns the page's props:

```text
app/pages/
  team.html
  team.server.ts
```

```ts
// app/pages/team.server.ts
import { people } from '@/lib/people.ts';

export function load() {
  return { props: { people } };
}
```

```html
<!-- app/pages/team.html -->
<template component="page-team">
  <title>Team</title>
  <defs>
    <prop name="people" type="list(object({ name: string, role: string }))" required>Team members</prop>
  </defs>
  <ul>
    <li $each="person of $people">{$person.name}, {$person.role}</li>
  </ul>
</template>
```

Loader files run only on the server, never in the browser, so they can read files, call APIs, and
import server-only packages. `@/` is the project root.

## What `load()` returns

| Field | Purpose |
| --- | --- |
| `props` | Values for the page's declared `<prop>`s. |
| `state` | Starting values for the page's declared `<state>`. |
| `head` | `title`, `description`, or `lang` for the document head. |
| `data` | Private values passed on to inner loaders as `parent`; never sent to the browser. |

Props and state are written into the page's HTML and its navigation data file, so **anything in
them is public**. Keep secrets in `data` or out of the result entirely.

## What `load()` receives

| Field | Value |
| --- | --- |
| `params` | URL parameters, such as `{ slug: 'first-post' }` for `blog/[slug].html`, or a list of segments for a [catch-all](/htmlkit/routes#catch-all-pages), such as `{ path: ['guide', 'intro'] }`. |
| `url` | The page URL, using the configured `origin`. |
| `base` | The site's base path, for building links. |
| `parent` | `data` from the layout loaders that ran before this one. |
| `propNames` | The props this loader's page or layout declares, which are the props `load()` may return. |
| `navigation(query)` | The site's pages, for [navigation](/htmlkit/navigation). |
| `redirect(location, status)` | Stops loading and sends the reader to `location` instead ([below](#redirecting)). |
| `fetch`, `signal` | The standard `fetch`, and an `AbortSignal` for the render. |

Static builds have no visitor request, so `request` and query parameters are not available.

## Dynamic pages

A dynamic page's loader lists every page to build with `entries()`:

```ts
// app/pages/blog/[slug].server.ts
import { posts } from '@/lib/posts.ts';

export const entries = () => posts.map(post => ({ slug: post.slug }));

export function load({ params }) {
  const post = posts.find(post => post.slug === params.slug)!;
  return { props: { title: post.title, body: post.body }, head: { title: post.title } };
}
```

Development renders any value; a build renders exactly the listed ones and reports a dynamic page
without `entries()`. Each entry gives every parameter of the page: a string for `[slug]`, and a
list of segments for `[...path]` (at least one) or `[[...path]]` (any number, so `[]` is the
folder's own URL).

## Redirecting

`redirect(location, status)` ends the loader and answers with a redirect instead of the page.
`location` is an application path, which gets the site's base path, or an `http(s)` URL. The status
is 303 unless you pass 301, 302, 307, or 308:

```ts
// app/pages/account.server.ts
export function load({ redirect }) {
  redirect('/login/');
}
```

The development server and `application.fetch` answer with that status and a `Location` header. A
static build writes a redirect page at the page's URL, as for the
[`redirects` option](/htmlkit/routes#redirects), and lists it in the manifest's `redirects`.

## Layout loaders

A layout can have a loader too, such as `app/layouts/default.server.ts` or a folder's
`_layout.server.ts`. Layout loaders run first,
from the outside in, then the page's. Each receives the `data` of the ones before it as `parent`.

## In the browser

HTMLKit sends the rendered HTML, then a script per page with the page's components compiled to
direct DOM code. They take over that HTML in place: controllers connect and browser data reads
start, without re-rendering, and whatever a reader typed before the script ran stays. A page ships
only the HTML Next code its components use. After that, links to other pages render in place; see
[Moving between pages](/htmlkit/client-navigation).

- A component's controller can be TypeScript: write `controller="./counter.js"` next to
  `counter.ts`, and HTMLKit compiles it. Run `tsc` separately to check types.
- Component styles become regular stylesheets that load before the page is shown.
- Files in `public/` are copied unchanged. `_htmlkit/` and `404.html` are reserved names.
- `document` fires `hk:ready` once the page's components have taken over its HTML.
- After any change in development, open pages reload.
