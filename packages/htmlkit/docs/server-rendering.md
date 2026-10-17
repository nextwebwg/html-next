# Request-time server rendering design

HTMLKit renders a page at build time or on each request through one render kernel, so a page's
authored files don't change when it moves between the two. Route matching, layout selection,
`hk:page` selection, the loader result contract, head merging, and the HTML Next rendering and
adoption path are the same in both. A page's `hk:render` metadata chooses: `prerender`, the default,
or `server`. This is a tooling implementation design, not a component-language specification; the
[deployment guide](./guide/deployment.md) describes the behavior for authors.

## Shared work and adapter responsibilities

`src/server.ts` is the request-time core, and it imports nothing from Vite:

- `renderRoute` runs a route's loaders, outermost first, serializes their props into standard
  component invocations, merges head metadata, and renders through HTML Next's `renderComponents`.
  Without a request it builds the prerender context, whose `request`, `cookies`, and `response`
  throw a diagnostic; with one it builds the request context. For a POST it first runs the page's
  action with the page layer's context: nothing returned redirects 303 to the page's URL without
  the `?/name` key, and an object becomes page props over the page loader's.
- `pageAction` finds the action a POST names, `?/name` or `default`, or answers 405 for a page
  without `actions` and 404 for an unknown name. Each application calls it before rendering.
- `respond` answers a `Request`: a page payload URL becomes its page's URL, middleware runs, then
  the redirects table, endpoints (paths without a trailing slash), and pages (GET, HEAD, and POST,
  308 to the trailing slash). A POST from another site gets 403 first: `Sec-Fetch-Site` must be
  `same-origin` or `none`, or without it, `Origin`'s host must be the request's, as Go's
  `CrossOriginProtection` decides. A request with neither header is no browser's form.
- `createNavigation` answers `navigation()`, `navigationTree()`, `breadcrumbs()`, and `pager()` from
  routes and the concrete page URLs.

Two applications supply the rest of a `Pipeline`:

```text
Request
  -> payload URL to page URL -> middleware(request, next)
  -> redirects -> endpoint (exported method, or 405 with Allow)
  -> page match -> prerendered: application.render / the build's file
                -> server: renderRoute with the request (POST: same-origin check, action, then loaders)
  -> Response (status, headers, Set-Cookie, body)
```

- `createApplication` (development, `application.fetch`) loads loaders, endpoints, and middleware
  through Vite's module runner and each route's component graph through `loadNodeComponents`. A
  prerendered page renders at its canonical `origin` URL, as the build renders it.
- The build writes `_htmlkit/server/entry.js`, whose default export is `serverApplication`'s result.
  The entry carries the server data as JSON: path-free routes, the navigation catalog, head scripts,
  redirects, and each server route's component definitions, head metadata, and browser assets. Vite
  builds the server-rendered pages' loaders, the endpoints, and the middleware to
  `_htmlkit/server/<id>.js` in a production worker, with packages left as imports; the entry imports
  each on first use. Prerendered pages and assets are served from the output's files, and
  `_htmlkit/server/` itself never is.

`startApplication` (`htmlkit start`) adapts `node:http` to `Request` and `Response`: the method, the
URL from the `Host` header, raw headers, a streamed body for other methods, and an abort signal for
a closed response. It writes `getSetCookie()`'s values as separate headers and streams the body.
Deno and Bun take the entry's `fetch` as it is. CI runs the built entry on Node, Deno, and Bun from
packed packages (`scripts/runtime-smoke.mjs`).

## Isolation and public data

For simultaneous `/items/alice/` and `/items/bob/` requests, matching creates distinct parameter
objects. Each request gets its own `Request`, abort signal, cookie map, response status and headers,
parent-data chain, loader results, invocation markup, and initial state map. Only immutable build
data and asset URLs are shared, and no request's result enters a shared cache. A test renders two
requests with different cookies at once and checks neither sees the other's.

### Render workers

HTML Next's `renderComponents` renders in a pool of long-lived workers, the number of available
CPUs up to 8 unless `setRenderWorkers(count)` sets another (`htmlkit --render-workers`, or
`startApplication({ renderWorkers })`). Each worker renders one request at a time and the others
wait in a queue. Every render gets:

- its own JSDOM window and document, created for the render and closed after it;
- browser globals (`Node`, `Element`, `HTMLElement`, `Event`, and the rest the runtime reads) pointed
  at that window during the render and restored afterwards;
- its own component registry, which belongs to the document, and its own component instances,
  reactive state, and bindings, which belong to the document's elements;
- its own copies of the definitions, state, and URL, which arrive as structured clones.

A worker keeps only what loading its modules creates: jsdom, the HTML Next runtime, the
`Intl.DurationFormat` polyfill, the projected-slot parser the runtime installs once, and the
runtime's static tables, such as SVG attribute names. It caches no definitions, documents, or
rendered output. HTML Next's request-isolation test renders requests with conflicting definitions
of one tag and conflicting state, concurrently and in sequence, on one worker and on three. A worker
that fails or exits rejects the render it was doing, which a server answers with its error page, and
the next render starts a new worker. An idle worker doesn't keep the process alive.

Each page is one render of the layers' invocations, with the application document's own head
(`renderComponents`' `head` option: the viewport meta, and an alias page's canonical link). HTML
Next reconciles every rendered component's head declarations into it, deepest first, and returns the
head HTML that the document assembler writes after the charset and head scripts. HTMLKit's `hk:`
settings are left out of the definitions before they render or compile.

Loaders, endpoints, and middleware are trusted application code that runs in the server's process,
as in Nuxt and Next.js: a module loads once, so a value it keeps in a module variable is shared by
every request. The guide says so beside the request API.

`data` is private to the loader chain. Only explicit `props` and `state` become public, through
HTML Next type validation, attribute serialization, and rendered continuation records. Head
declarations bind through HTML Next's parser and renderer like any other binding, and the server
renderer serializes and escapes the elements it writes. Browser entries import the page's compiled components and their
controllers, never server loaders or their imports.

## Cost

`pnpm --filter @nextwebwg/htmlkit measure:server` builds a small site and loads `htmlkit start` with
keep-alive clients. A render in a warm worker takes a few milliseconds to create its document and a
few more to render and serialize a small page; starting a worker and importing jsdom takes 0.4 to
0.9 s, which each worker pays once. With 16 connections on a shared machine (load average about 22):

| Route | Requests/s | p50 | p99 |
| --- | --- | --- | --- |
| Prerendered page | 6,852 | 1.5 ms | 17.2 ms |
| Server-rendered page, with a layout | 997 | 14.0 ms | 45.1 ms |
| Endpoint | 15,914 | 0.8 ms | 4.9 ms |

The same pool and single render make builds faster: building the examples and the docs proof takes
3.2 s on the same machine.

## Native mechanisms and the remaining gap

Native `URL`, `Request`, `Response`, `Headers`, `fetch`, and `AbortSignal` cover URL parsing, HTTP
values, cookies (the `Cookie` and `Set-Cookie` headers), network reads, and cancellation; HTMLKit
adds a parsed cookie map and nothing else. Native anchors and the Navigation API carry routing;
client navigation renders each page from its module and data payload, whose URL carries the page's
query, or its server document ([client-navigation.md](./client-navigation.md)). HTML Next provides
named-slot composition, typed props and state, isolated DOM rendering, rendered continuation
serialization, adoption, controller connection and disposal, and browser read resumption. Vite
supplies module resolution, TypeScript transformation, asset bundling, and development watching.

The platform layer is application policy: file and registered route discovery and matching, layout
ordering, loader sequencing, document metadata, deployment URL composition, the request pipeline,
and the Node adapter. No custom browser observer, parser, reactive scheduler, or hydration engine is
needed.
