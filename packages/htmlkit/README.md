# HTMLKit

HTMLKit (`@nextwebwg/htmlkit`) builds applications with HTML Next components. It provides routes,
layouts, server loaders, endpoints, middleware, browser delivery, and development tools. A build
prerenders pages for any static host and writes a request server for pages that render on each
request, which `htmlkit start` runs on Node and Deno and Bun run through its `fetch`.
[The server-rendering design](./docs/server-rendering.md) records how requests are answered.

Use Node `>=22.22.2 <23 || >=24.15 <25`. Install `@nextwebwg/htmlkit` and add its commands to your
`package.json` scripts:

```json
{
  "scripts": {
    "dev": "htmlkit dev",
    "build": "htmlkit build",
    "preview": "htmlkit preview",
    "start": "htmlkit start"
  }
}
```

Then run `pnpm dev`, `pnpm build`, `pnpm preview`, or `pnpm start` (`npm run dev` and the others work too).

**Guide:** [nextwebwg.org/htmlkit](https://nextwebwg.org/htmlkit/) covers pages and routing,
loading data, endpoints and middleware, navigation, moving between pages, deployment, and
configuration. Its source is
[`docs/guide`](./docs/guide/) in this package.
[The client-navigation design](./docs/client-navigation.md) records how pages swap in place.

## Proof applications

From this monorepo, after building packages:

```sh
cd packages/htmlkit
node dist/cli.js build examples/basic
node dist/cli.js preview examples/basic
pnpm build:docs-proof
node dist/cli.js preview ../../.context/htmlkit-docs-proof
```

The basic application exercises routes, loaders, state, and controllers without documentation
features. The docs proof converts this repository's Markdown guides and generates a component
reference, code display, heading anchors, search navigation, a theme, and an interactive example.
Its Markdown dependency and theme live in the consumer, outside the platform runtime and published
package. Its input is trusted, checked-in author content; it does not sanitize arbitrary Markdown.

Larger documentation migrations must qualify their routes, examples, visuals, and browser behavior
against reviewed references before switching deployment. This initial proof exercises the platform;
it does not replace an existing documentation site's production output.

HTMLKit is MIT-licensed and shares the monorepo release version. It is configured for public npm
publication; creating its npm name once and configuring its trusted publisher are release setup,
not development build steps.
