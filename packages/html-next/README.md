# `@nextwebwg/html-next`

Reference implementation for the [Declarative HTML Components proposal](https://nextwebwg.org/html-next/)
and the [HTML Forms proposal](https://nextwebwg.org/html-forms/): the validity model
(`@nextwebwg/html-next/validation`) and native form request construction
(`@nextwebwg/html-next/forms`). It replaces `@nextwebwg/declarative-components`. It provides three
paths over one component language:

- a complete browser distributable for dynamic component graphs;
- an application/library compiler that emits native DOM and graph-scoped runtime support; and
- a converter that emits Vue components with no HTML Next left in them (React is in development).

The live runtime supports every declarative capability. Builds analyze an application or library
graph and share the support that graph requires; Vue conversion preserves the same observable
contract through Vue's own reactivity.

`@nextwebwg/html-next/forms` builds requests from native forms and submitters, preserving
successful-control, validation, encoding, and cancellation semantics. It accepts native DOM objects
and imports nothing else from this package, so a consumer that only wants HTML Forms pays only for
that subpath.

See the [proposal](https://nextwebwg.org/html-next/) and
[independent goal ledger](docs/delivery-goals.md).

The package is experimental and is not published yet. From the repository root:

```sh
corepack pnpm build
corepack pnpm test
```

Release-candidate mechanics and the deliberately separate publication-policy gate are documented
in [the release guide](docs/releasing.md).
