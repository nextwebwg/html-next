---
title: Deployment
order: 6
blurb: static hosts · htmlkit start · Deno · Bun · prerendered and server pages
eyebrow: HTMLKit
---

# Deployment

`htmlkit build` writes everything a deployment needs to `dist/`: each prerendered page as a file,
the browser bundles, and a request server for the pages, endpoints, and middleware that run on each
request. A site of prerendered pages deploys to any static host. A site that renders pages on request,
or has endpoints or middleware, runs `htmlkit start`, or the same server on Deno or Bun.

## Prerendered and server pages

Every page is prerendered unless it says otherwise: the build runs its loader once and writes its
HTML. A page with `<meta name="hk:render" content="server">` renders on each request instead, so its
loader can read the [request](/htmlkit/loaders#rendering-on-each-request):

```html
<!-- app/pages/account.html -->
<template component="page-account">
  <defs><meta name="hk:render" content="server"></defs>
  …
</template>
```

| | Prerendered (default) | `hk:render` `server` |
| --- | --- | --- |
| Loader runs | once, at build time | on each request |
| Loader reads | params, `url` under `origin` | also the query, headers, cookies, and `request` |
| Loader sets | | the status and response headers |
| Dynamic pages | `entries()` lists every page | any URL the pattern matches |
| Output | `index.html` and a navigation payload | none; the server renders it |
| Static host | serves it | can't serve it |

The setting goes in the page because whether a page needs the request is a property of its loader,
which lives beside it. Both kinds of page share layouts, navigation, client navigation, and browser
bundles, and the development server renders each as the build will.

## Static hosts

When every page is prerendered and there are no endpoints or middleware, upload `dist/` to any static
host, such as GitHub Pages, Netlify, or an S3 bucket:

- Set the host's "page not found" response to `404.html`, your
  [not-found page](/htmlkit/routes#the-not-found-page).
- Build with the `--base` you deploy under, such as `--base /docs/` for a project page.
- Page URLs end in a slash. Most hosts serve `/about/` from `about/index.html` and redirect `/about`
  to it; check your host's trailing-slash setting.
- Redirects are pages that send readers on; see [redirects](/htmlkit/routes#redirects).

`htmlkit preview` serves `dist/` the way a static host does, to check a build first.

## The Node server

`htmlkit start` serves the build on Node, without Vite: prerendered pages and assets from `dist/`'s
files, server-rendered pages, endpoints, and middleware:

```json
{
  "scripts": {
    "build": "htmlkit build",
    "start": "htmlkit start"
  }
}
```

```sh
npm run build
PORT=8080 HOST=0.0.0.0 npm start
```

- It listens on `127.0.0.1:3000`. `--port` and `--host`, or the `PORT` and `HOST` environment
  variables, change that; the flags win.
- It takes the base path from the build, and `--out-dir` names another build than `dist/`.
  It doesn't read `htmlkit.config.ts`.
- Pages that render on request render in a pool of workers, one page at a time each, each in a fresh
  document. The pool has one worker per available CPU, up to 8; `--render-workers` sets another
  count. Each worker holds its own jsdom and HTML Next runtime in memory.
- When a loader, endpoint, middleware, or render fails, or a render worker ends, the request gets
  [`app/error.html`](/htmlkit/routes#the-error-page) with status 500, and the next request
  renders on a new worker.
- Hashed bundles in `_htmlkit/` are served with `Cache-Control: public, max-age=31536000, immutable`.
- `dist/_htmlkit/server/` holds the server's code; it is never served.
- The server imports `@nextwebwg/htmlkit` and your loaders' packages from `node_modules`, so deploy
  `dist/` with `package.json` and the installed production dependencies, as for any Node application:

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV HOST=0.0.0.0 PORT=8080
CMD ["npm", "start"]
```

The server builds request URLs from the `Host` header over `http`. Behind a proxy that terminates
TLS, a loader reads the original scheme from the proxy's header, such as `x-forwarded-proto`.
Compression is the proxy's to add.

## Deno and Bun

`dist/_htmlkit/server/entry.js`'s default export is the application, whose `fetch` takes a standard
`Request` and returns a `Response`. Deno and Bun serve it as it is:

```sh
deno serve --allow-all dist/_htmlkit/server/entry.js
bun dist/_htmlkit/server/entry.js
```

or from your own module:

```ts
import application from './dist/_htmlkit/server/entry.js';

Deno.serve({ port: 8080 }, application.fetch);
// Bun.serve({ port: 8080, fetch: application.fetch });
```

To set the render pool's size there, call `setRenderWorkers(count)` from `@nextwebwg/htmlkit/server`
before the first request. Build with Node, then run the entry where `node_modules` has the installed
packages. CI runs the same
built entry on Node, Deno 2.8+, and Bun.

## From code

`startApplication` is `htmlkit start`, from `@nextwebwg/htmlkit/server`, which never loads Vite:

```ts
import { startApplication } from '@nextwebwg/htmlkit/server';

const server = await startApplication({ outDir: 'dist', port: 8080 });
console.log(server.url);
await server.close();
```
