---
title: Loading data
order: 2
blurb: loaders · props · what reaches the browser
eyebrow: HTMLKit
---

# Loading data

Put a `.server.ts` file next to a page with the same name. Its `load()` runs at build time (and on
each request in development), or on each request for a page that
[renders on each request](#rendering-on-each-request), and returns the page's props:

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
| `navigationTree(query)` | The same pages nested by folder and group, for [`<hk-nav>`](/htmlkit/navigation#a-navigation-tree). |
| `redirect(location, status)` | Stops loading and sends the reader to `location` instead ([below](#redirecting)). |
| `notFound()` | Stops loading and answers with the [not-found page](/htmlkit/routes#the-not-found-page) and status 404. |
| `phase` | `'prerender'` at build time, `'request'` for a page that renders on each request. |
| `request`, `cookies`, `response` | The request, its cookies, and the response's status and headers, for a page that [renders on each request](#rendering-on-each-request). |
| `fetch`, `signal` | The standard `fetch`, and an `AbortSignal` for the render. |

A prerendered page has no visitor request: its `url` has no query, and reading `request`, `cookies`,
or `response` is an error that names the loader.

## Rendering on each request

`<meta name="hk:render" content="server">` in a page renders it on each request, under
`htmlkit dev` and [`htmlkit start`](/htmlkit/deployment#the-node-server). Its loaders, and its
layouts' loaders, then read the request and shape the response:

```html
<!-- app/pages/orders.html -->
<template component="page-orders">
  <meta name="hk:render" content="server">
  <title>Orders</title>
  <defs>
    <prop name="orders" type="list(object({ id: string, total: string }))" required>Orders</prop>
  </defs>
  <ul><li $each="order of $orders">{$order.id}: {$order.total}</li></ul>
</template>
```

```ts
// app/pages/orders.server.ts
import type { LoadContext } from '@nextwebwg/htmlkit';
import { db } from '@/lib/db.ts';

export async function load({ url, cookies, request, response, redirect, notFound }: LoadContext) {
  const user = await db.sessions.user(cookies.get('session'));
  if (user === undefined) redirect('/login/');
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isInteger(page) || page < 1) notFound();
  response.headers.set('cache-control', 'private, max-age=60');
  response.headers.append('set-cookie', `last-page=${page}; Path=/; SameSite=Lax`);
  return { props: { orders: await db.orders.list(user, page) } };
}
```

| Field | Value |
| --- | --- |
| `url` | The request's URL, with its query: `url.searchParams.get('page')`. |
| `request` | The standard `Request`: `request.headers.get('accept-language')`, `request.method`. |
| `cookies` | The request's cookies by name, a `Map`: `cookies.get('session')`. |
| `response.status` | The page's status, 200 unless a loader sets another. |
| `response.headers` | The response's `Headers`. A cookie is a `Set-Cookie` header: `response.headers.append('set-cookie', …)`. |

Every loader of the page shares `response`, and a redirect or `notFound()` keeps the headers set
before it, so a loader can set a cookie and then redirect. A dynamic page that renders on each request
renders any URL its pattern matches, with no `entries()`, and its loader calls `notFound()` for one it
doesn't know. Client navigation fetches the page's data with the same query and cookies, through the
same loaders. See [deployment](/htmlkit/deployment#prerendered-and-server-pages) for how the two kinds
of page are built and served, and [endpoints and middleware](/htmlkit/server) for requests that aren't
pages.

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
folder's own URL). A listed page whose loader calls `notFound()` is left out of the build.

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

The development server, `htmlkit start`, and `application.fetch` answer with that status and a `Location` header. A
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
- Files in `public/` are copied unchanged, and a symbolic link there is an error. `_htmlkit/` and `404.html` are reserved names, and so is
  `robots.txt` when the [`robots` option](/htmlkit/configuration#search-engines) is set.
- `document` fires `hk:ready` once the page's components have taken over its HTML.
- After any change in development, open pages reload.
