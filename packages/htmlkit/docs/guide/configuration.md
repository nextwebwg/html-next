---
title: Configuration and API
order: 4
blurb: htmlkit.config.ts · explicit routes · library API
eyebrow: HTMLKit
---

# Configuration and API

Use `htmlkit.config.ts` (or `.js`) for configuration. Explicit routes supplement file routes, or
set `fileRoutes: false` for a fully registered route table:

```ts
import { defineConfig } from '@nextwebwg/htmlkit';

export default defineConfig({
  base: '/docs/',
  layoutDefaults: { '/admin/': 'admin', '/account/': 'account' },
  routes: [{
    pattern: '/catalog/[id]/',
    component: 'app/catalog/item.html',
    server: 'app/catalog/item.server.ts',
    layouts: [{ component: 'app/catalog/shell.html' }],
  }],
});
```

Page layout metadata wins over the most specific `layoutDefaults` directory prefix, then the
application `layout` option (a name or `false`), then the automatic default layout. Registered
`layouts` can supply an explicit outer-to-inner chain when no named/default override is chosen.

Paths are relative to the application root. Explicit routes use the same parameter, loader,
composition, collision, and entry rules as file routes; they do not create another renderer.
No config file is read implicitly by the library API: pass options directly to `createApplication`,
`buildApplication`, `devApplication`, or `previewApplication`. Close returned applications and
servers when finished. `Application.render(pathname, signal?)` returns a baseline document, body,
styles, metadata, and the parsed component graph; browser delivery is added by dev/build.

## Serving requests

`Application.fetch(request)` serves rendered pages for a native `Request` and returns a `Response`,
so the same handler runs on Node, Deno 2.8+, and Bun: GET and HEAD under `base`, a 308 redirect to a
route's trailing-slash URL, 404 for unknown paths, and 405 for other methods. The development server
uses it for every page; CI runs it on Deno and Bun. Pass the function itself, as in
`Deno.serve(application.fetch)`. Loaders still run in the `prerender` phase, because static
generation is the only production target, and documents served this way include browser modules only
when an adapter supplies them, as the development server does.

