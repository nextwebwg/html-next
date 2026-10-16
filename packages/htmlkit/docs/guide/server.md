---
title: Endpoints and middleware
order: 3
blurb: app/api · GET and POST · middleware · cookies and headers
eyebrow: HTMLKit
---

# Endpoints and middleware

An endpoint is a file in `app/api` that answers HTTP requests with a standard `Response`, such as JSON
for a page's scripts. Middleware is one file, `app/middleware.server.ts`, that sees every page and
endpoint request first. Both run on the server, in development and under
[`htmlkit start`](/htmlkit/deployment#the-node-server), and use the web's own `Request`, `Response`,
`Headers`, and `URL`.

## Endpoints

Each `.server.ts` (or `.server.js`) file in `app/api` is an endpoint at the matching path, without a
trailing slash:

```text
app/api/
  todos.server.ts         /api/todos
  todos/[id].server.ts    /api/todos/42
  feed.xml.server.ts      /api/feed.xml
  index.server.ts         /api
```

A file exports a function for each HTTP method it answers: `GET`, `POST`, `PUT`, `PATCH`, or
`DELETE`. Each receives the `Request` and the URL's parameters, and returns a `Response`:

```ts
// app/api/todos.server.ts
import type { EndpointHandler } from '@nextwebwg/htmlkit';
import { db } from '@/lib/db.ts';

export const GET: EndpointHandler = async request => {
  const done = new URL(request.url).searchParams.get('done');
  return Response.json(await db.todos.list({ done: done === 'true' }));
};

export const POST: EndpointHandler = async request => {
  const todo = await db.todos.add(await request.json());
  return Response.json(todo, { status: 201 });
};
```

```ts
// app/api/todos/[id].server.ts
import type { EndpointHandler } from '@nextwebwg/htmlkit';
import { db } from '@/lib/db.ts';

export const DELETE: EndpointHandler = async (request, { params }) => {
  await db.todos.remove(params.id);
  return new Response(null, { status: 204 });
};
```

- `HEAD` answers with `GET`'s status and headers and no body, unless the file exports `HEAD`.
- A method the file doesn't export answers 405, with an `Allow` header listing the ones it does.
- Parameters follow [page parameters](/htmlkit/routes#dynamic-pages): `[id]` is a segment, and
  `[...path]` and `[[...path]]` are lists of segments.
- A component's controller reads an endpoint with `fetch('/api/todos')`.
- A static build has no server, so endpoints answer only under `htmlkit dev` and `htmlkit start`.

## Middleware

`app/middleware.server.ts` exports one function. It receives each request and `next`, which answers
the request as the application would, and returns a `Response`:

```ts
// app/middleware.server.ts
import type { Middleware } from '@nextwebwg/htmlkit';

const middleware: Middleware = async (request, next) => {
  const url = new URL(request.url);
  const session = request.headers.get('cookie')?.includes('session=');
  // Return a response of its own, such as a redirect: no loader runs.
  if (url.pathname.startsWith('/account/') && !session) {
    return Response.redirect(new URL('/login/', url), 303);
  }
  // Or answer as another path would: a rewrite.
  if (url.pathname === '/home/') return next('/');
  // Or let the request through, then change the response's headers.
  const response = await next();
  response.headers.set('x-frame-options', 'DENY');
  response.headers.append('set-cookie', 'seen=1; Path=/; SameSite=Lax');
  return response;
};

export default middleware;
```

| To… | Return |
| --- | --- |
| Let the request through | `next()` |
| Redirect | `Response.redirect(new URL('/login/', request.url), 303)` |
| Answer as another path, a rewrite | `next('/other/')` or `next(new URL(…))` |
| Pass loaders a changed request, such as an added header | `next(new Request(request, { headers }))` |
| Answer with your own response | `new Response('Members only', { status: 401 })` |
| Set headers or cookies | `const response = await next()`, then `response.headers.set(…)` or `.append('set-cookie', …)` |

Middleware runs before every page, prerendered or server-rendered, before every endpoint, and before
missing paths. Files, such as `public/` assets and HTMLKit's bundles, are served without it. When client
navigation loads a page's data, middleware sees the page's own URL, so a rule for `/account/` covers
moving to it in place too. A static host serves files as they are, so middleware runs only under
`htmlkit dev` and `htmlkit start`.

## Cookies and headers

Loaders, endpoints, and middleware all read the request's headers and cookies and set the
response's:

| Where | Read | Set |
| --- | --- | --- |
| A server-rendered page's loader | `request.headers`, `cookies.get('name')` | `response.status`, `response.headers` ([details](/htmlkit/loaders#rendering-on-each-request)) |
| An endpoint | `request.headers` | the `Response` it returns |
| Middleware | `request.headers` | `response.headers` of `next()`'s response, or its own `Response` |

A cookie is a `Set-Cookie` header, so `headers.append('set-cookie', 'theme=dark; Path=/')` sets one,
and each `append` adds another.

Server modules run in the server's process and are loaded once, as in Node, so a value a module keeps
in a variable is shared by every request. Keep per-request values in the request, the loader's
context, or a store keyed by the request's session.
