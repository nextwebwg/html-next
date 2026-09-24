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

### Runtime entry points

`@nextwebwg/html-next/runtime` is the general renderer: it registers already parsed definitions,
lowers instances, and runs reactivity. It carries no component parser, so a build-time graph pays
nothing for one (about 6 KB gzip on a representative app).

`@nextwebwg/html-next/live` is the same runtime plus the parser that reads `<template component>`
definitions authored in a document. `startBrowserComponents()` already installs it; import `live`
directly when calling `lowerDocument()` or `observeDocument()` against a page that authors
definitions in HTML. Reading a definition from a document without that parser is a stable `HR007`
diagnostic rather than a silent no-op.

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
