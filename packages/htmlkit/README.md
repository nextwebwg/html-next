# HTMLKit

HTMLKit (`@nextwebwg/htmlkit`) builds applications with HTML Next components. It provides routes,
layouts, server loaders, browser delivery, and development tools. The first production adapter
generates static pages; [the server-rendering design](./docs/server-rendering.md) preserves a path
to request-time rendering.

Use Node `>=22.22.2 <23 || >=24.15 <25`. Install `@nextwebwg/htmlkit` and add its commands to your
`package.json` scripts:

```json
{
  "scripts": {
    "dev": "htmlkit dev",
    "build": "htmlkit build",
    "preview": "htmlkit preview"
  }
}
```

Then run `pnpm dev`, `pnpm build`, or `pnpm preview` (`npm run dev` and the others work too).

**Guide:** [nextwebwg.org/htmlkit](https://nextwebwg.org/htmlkit/) covers pages and routing,
loading data, navigation, moving between pages, and configuration. Its source is
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
