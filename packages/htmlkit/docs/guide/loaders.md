---
title: Loading data
order: 2
blurb: component providers · loaders · public values
eyebrow: HTMLKit
---

# Loading data

Components receive data through their typed props. A component module can provide them during
prerendering, request-time rendering, and browser updates. A page loader can also supply ordinary
values before rendering; supplied values bypass that prop's provider.

| Source | First render | Later browser reads |
| --- | --- | --- |
| Common `.js` or `.ts` provider | Prerendered or rendered on request | The same provider runs in the browser. |
| `.client` reader | Loading branch, unless a common or private reader prepared data | The client reader runs in the browser. |
| `.server` reader with a common selector | Prerendered or rendered on request | The request server runs the private reader; an optional client reader overrides this. |
| Supplied prop value | The supplied value | No provider read while the caller owns that prop. |

## Component providers in the browser

Put a JavaScript or TypeScript module beside a component with the same name. Its `props` export
provides values for the component's declared props:

```text
app/components/
  product-card.html
  product-card.js
```

```html
<!-- app/components/product-card.html -->
<template component="product-card">
  <defs>
    <prop name="productId" type="string">Lookup key.</prop>
    <prop name="product" type="object({ name: string })">Displayed product.</prop>
  </defs>
  <article>
    <h2 $await="$product">{$product.name}</h2>
    <p $error="problem">{$problem.message}</p>
    <p $else>Loading product…</p>
  </article>
</template>
```

```js
// app/components/product-card.js
export const props = {
  product: {
    initial: 'browser',
    input: ({ productId }) => productId,
    async load(id, { fetch, signal }) {
      const response = await fetch(`/api/products/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error('Product unavailable');
      return response.json();
    },
  },
};
```

`initial: 'browser'` leaves the loading branch in prerendered HTML and starts the read when the
component connects in the browser. The selector reads ordinary typed props; changing `productId`
starts a current read and cancels the previous one. A supplied value bypasses the provider, so a
fixture needs no lookup key or network mock:

```html
<product-card product-id="42"></product-card>
<product-card product='{"name":"Preview product"}'></product-card>
```

An optional named `connect(host, { signal })` export adds browser behavior. It runs on each
connection and can return cleanup. A passive `create()` factory can instead return `{ props, connect }`
for per-instance closures; it does not start requests or browser work. Data reads belong in `load`.

An explicit `module="./behavior.js"` selects that module instead of a same-name companion.
If both `.js` and `.ts` companions exist, select one explicitly. A file declaring several components
also uses explicit module pointers rather than attaching one companion to every component.
Existing `controller` components keep their legacy lifecycle.

## Prepared library modules

A library may own its binding instance and export its named `connect`, `prepare`
and `adopt` functions, rather than exporting a raw provider definition. HTMLKit
recognizes the `prepare`/`adopt` pair through runtime exports and re-exports
without evaluating browser behavior during discovery. All three exports must be
functions. Server preparation uses the existing binding preparation context;
browser connection and navigation adopt matching read identities before running
the module's interactions. Supplied props keep precedence over providers.

The library retains the same instance for preparation/adoption and connection.
When creating a browser adapter in `adopt`, use the host-checked
`adoption.snapshot.source` as its source revision. An ordinary `{ props, connect }`
or `create()` module remains preferable when HTMLKit should compose environment
readers. A prepared module owns its providers internally and cannot also attach
`.client` or `.server` provider overrides; expose a raw definition to use those
overrides.

## Browser-only companion modules

Use a `.client.js` or `.client.ts` companion for browser-only imports and readers. HTMLKit imports it
only in the browser graph. A shared module can keep the selector while the client file supplies the
reader:

```js
// product-card.js
export const props = {
  product: { input: ({ productId }) => productId },
};
```

```js
// product-card.client.js
const storage = window.localStorage;

export const props = {
  product: {
    load(id) {
      const product = JSON.parse(storage.getItem(`product:${id}`) ?? 'null');
      if (product === null) throw new Error('Product unavailable');
      return product;
    },
  },
};
```

The browser reader inherits the shared selector and policy. Without a shared reader, server rendering
leaves the authored loading branch in place. A client file can instead define complete providers
with both `input` and `load`, with no shared module. Supplied props bypass either form.

When both environments have a reader, HTMLKit prepares the common reader on the server and adopts
that result in the browser. Later browser reads use the client reader. For a read on every activation,
set `revalidate: 'activate'` in the client provider.

Both files may export `connect` or a passive `create()` returning `{ props, connect }`. Their connection
hooks start in common-then-client order for each browser activation, and cleanups run in reverse order.
An asynchronous setup that finishes after disconnection still releases its resources. Reconnecting a
retained component reuses both factories' passive state.

An explicit common module pointer also selects companions beside that module. An explicit pointer to
a `.client` entry selects it as the browser-only module. Keep one `.client.js` or `.client.ts` per stem;
ambiguous companions produce a diagnostic. Imported package components and legacy controllers keep
their explicit entry points.

## Preparing the same provider on the server

Omit `initial: 'browser'` to prepare the provider before HTMLKit writes the page. Its `load` receives
`phase: 'build'` during prerendering, `'request'` during request-time rendering, and `'browser'` for
later client reads. Use a data function that works in those environments:

```js
import { readProduct } from './products.js';

export const props = {
  product: {
    input: ({ productId }) => productId,
    load: (id, { signal }) => readProduct(id, { signal }),
  },
};
```

The rendered value and matching read identity reach the browser together. Hydration adopts that
result without repeating the initial read. Changing `productId` starts a browser read, while local
draft state retains its edits. A failed read renders the component's `$error` branch.

Common module imports and `create()` must work without browser globals. Put browser API calls in
`connect`; HTMLKit never calls it during server preparation. A module exporting only `connect` is
left out of server preparation, including its browser-only imports. `initial: 'browser'` delays a
provider's read, but its common module still has to load on the server.

Common providers run in application-owned render workers. Modules are cached for a worker's lifetime,
so keep per-component mutable values inside passive `create()` closures rather than module variables.
Closing the application or reloading development sources retires its workers and temporary bundles.

A provider may supply a `required` prop, including one deferred with `initial: 'browser'`. While the
value is unavailable, `$await` selects its loading or error branch; ordinary constraint validity still
reports a missing required value. Server preparation diagnoses a missing page or layout input when its
common module has no provider for it. With a client companion, the browser owns its suppliers and
constraint validation; HTMLKit does not execute browser code to predict those suppliers on the server.

## Private component readers

A `.server.js` or `.server.ts` companion supplies readers that need server-only imports, credentials,
or application services. Keep the selector and refresh policy in the common module:

```js
// product-card.js
export const props = {
  product: { input: ({ productId }) => productId, keepPrevious: true },
};
```

```js
// product-card.server.js
import { products } from '@/lib/products.server.js';

export const props = {
  product: {
    async load(id, context) {
      if (context.phase === 'build') return products.publicProduct(id, context.signal);
      const user = await products.authenticate(context.request);
      return products.forUser(user, id, context.signal);
    },
  },
};
```

HTMLKit prepares the private reader before rendering. The browser adopts its result without another
request. When the selector changes, HTMLKit sends the selected declarations to its request server;
that server validates them, reruns the common selector, and calls the private reader with the current
request. A `.client` reader can override later browser reads while retaining the private SSR result.
Ordinary supplied props bypass all readers, including private ones.

Private reader context includes `phase` (`'build'` or `'request'`), `signal`, `fetch`, `sample`, `services`,
`url`, `base`, and route `params`. `request` and `cookies` are available only during the request phase;
reading them during a build throws. Check `phase` before reading or destructuring those properties.
`sample` is recomputed from the common module's `sample` selector for each operation.

Treat every input from a browser, including page URLs, params, computed values, and sampled fields,
as untrusted. Authorize each private read using the real request and server-owned information. A
component input or `when` condition is not an authorization check. Middleware runs for the read's
`_htmlkit/read` request; it does not run a second time for the page URL carried by that request.

Private `props` exports contain `{ load }` readers. Put `input`, `when`, `sample`, and scheduling
policy in the common module. Common selectors run synchronously and should depend on the declared
props and state, rather than mutable connection closures. Private reads are fresh operations, so
their companion exports no `create` or `connect`. A common factory is materialized afresh when the
server recomputes a browser request's selector; it is not the retained browser instance. Common and
client factories still retain their normal per-component lifetime in the browser.

The `.server` file may also export a page's existing `load`, `actions`, and `entries`. A loader-only
file keeps its existing behavior. An explicit common module selects its companions beside that
module, as with `.client` files. Server-only code stays in the built server and is never served as an
asset or imported by browser modules.

A thrown `Response` with status 400 or above deliberately exposes its text to the component's error
branch. Other failures are logged on the server and expose only a generic message. Private reads
carry cancellation when the selected input changes, the component deactivates, the request ends, or
its application closes. Readers should pass `signal` to cancellable work. HTMLKit ignores late
completion; it cannot forcibly stop arbitrary JavaScript running in an external service.

For application-owned services, pass `services` to `createApplication`, `devApplication`, or
`buildApplication`, and separately to `startApplication` or a built entry's `create(options)`.
Functions and service objects stay in the parent process rather than crossing into render workers.
The caller owns their setup and shutdown. `ServerReader`, `ServerReaders`, and `ServerReadContext`
are exported types from `@nextwebwg/htmlkit` for annotated private modules.

Pages with private browser reads require the HTMLKit request server even when their HTML is
prerendered. A static host can serve the initial result, but cannot answer later private reads;
use a client reader backed by a public API for that deployment.

## Page and layout loaders

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
  <defs>
    <prop name="people" type="list(object({ name: string, role: string }))" required>Team members</prop>
    <title>Team</title>
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
| `head` | `lang`, the document's language. Titles and metadata are [head declarations](/htmlkit/routes#the-page-head) bound to props. |
| `data` | Private values passed on to inner loaders as `parent`; never sent to the browser. |

Props and state are written into the page's HTML and its navigation data file, so **anything in
them is public**. Keep secrets in `data` or out of the result entirely.

Omitting a prop, or returning `undefined`, leaves its default implicit and allows its component
provider to run. Returning `null` supplies the prop: it uses the declared default when present,
and suppresses that provider. This distinction survives hydration and navigation, including a
layout kept between pages. Passing ordinary fixture values uses the same typed props.

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
  <defs>
    <prop name="orders" type="list(object({ id: string, total: string }))" required>Orders</prop>
    <meta name="hk:render" content="server">
    <title>Orders</title>
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
of page are built and served, [forms](/htmlkit/forms) for the actions that answer a page's form
submissions, and [endpoints and middleware](/htmlkit/server) for requests that aren't pages.

## Dynamic pages

A dynamic page's loader lists every page to build with `entries()`:

```ts
// app/pages/blog/[slug].server.ts
import { posts } from '@/lib/posts.ts';

export const entries = () => posts.map(post => ({ slug: post.slug }));

export function load({ params }) {
  const post = posts.find(post => post.slug === params.slug)!;
  return { props: { title: post.title, body: post.body } };
}
```

The page's `<title>{$title}</title>` in its `<defs>` puts the post's title in the document head.

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
direct DOM code. They take over that HTML in place: modules connect and browser data reads
start, without re-rendering, and whatever a reader typed before the script ran stays. A page ships
only the HTML Next code its components use. After that, links to other pages render in place; see
[Moving between pages](/htmlkit/client-navigation).

- A component module can be TypeScript: write `module="./counter.ts"`, and HTMLKit compiles it.
  Export a named `connect` for browser behavior. Run `tsc` separately to check types.
- Component styles become regular stylesheets that load before the page is shown.
- Files in `public/` are copied unchanged, and a symbolic link there is an error. `_htmlkit/` and `404.html` are reserved names, and so is
  `robots.txt` when the [`robots` option](/htmlkit/configuration#search-engines) is set.
- `document` fires `hk:ready` once the page's components have taken over its HTML.
- After any change in development, open pages reload.
