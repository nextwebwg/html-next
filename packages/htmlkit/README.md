# HTMLKit

HTMLKit (`@nextwebwg/htmlkit`) builds applications with HTML Next components. It provides routes,
layouts, server loaders, browser delivery, and development tools. The first production adapter
generates static pages; [the server-rendering design](./docs/server-rendering.md) preserves a path
to request-time rendering.

Use Node `>=22.22.2 <23 || >=24.15 <25` and Corepack pnpm. Install `@nextwebwg/htmlkit`, then run:

```sh
corepack pnpm exec htmlkit dev
corepack pnpm exec htmlkit build
corepack pnpm exec htmlkit preview
```

**Guide:** [nextwebwg.org/htmlkit](https://nextwebwg.org/htmlkit/) covers routes and layouts,
loaders and browser delivery, ordered routes and navigation, moving between pages, and
configuration. Its source is [`docs/guide`](./docs/guide/) in this package.
[The client-navigation design](./docs/client-navigation.md) records how pages swap in place.

## Proof applications

From this monorepo, after building packages:

```sh
corepack pnpm --filter @nextwebwg/htmlkit exec node dist/cli.js build examples/basic
corepack pnpm --filter @nextwebwg/htmlkit exec node dist/cli.js preview examples/basic
corepack pnpm --filter @nextwebwg/htmlkit build:docs-proof
corepack pnpm --filter @nextwebwg/htmlkit exec node dist/cli.js preview ../../.context/htmlkit-docs-proof
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
