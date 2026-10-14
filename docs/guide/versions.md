---
title: Versions and stability
order: 7
blurb: alpha today · what 1.0 promises · declaring what your library supports
eyebrow: HTML Next · Versions
---

# Versions and stability

**The proposal is still changing. Your components don't have to.** Stability comes from pinning a version of these tools, not from the proposal itself. A library or an application can be stable on one tools version while the proposal keeps moving.

> [!warn] Today: alpha releases
> The tools are `1.0.0-alpha` releases. They follow the proposal's live draft, so any alpha can break your components. From 1.0.0-alpha.41, the [changelog](https://github.com/nextwebwg/html-next/blob/main/CHANGELOG.md) lists each break under **Breaking**; earlier releases did not always, so read their **Changed** entries too. The promise on this page starts at 1.0. Items marked *planned* are not built yet.

## What a version means

All four packages (`html-next`, `html-next-unplugin`, `html-next-converter`, and `htmlkit`) share one version. From 1.0, each major version implements one dated [snapshot](https://nextwebwg.org/declarative-components/#stability) of the proposal: a copy published on one day that never changes afterwards.

| Tools version | Implements | Can an update break your components? |
| --- | --- | --- |
| `1.0.0-alpha.*` (now) | The live draft | Yes, in any release |
| `1.x` | The snapshot named at 1.0, plus additions from later drafts | No |
| `2.x` and later | A later snapshot | Only where that snapshot changed the syntax, with the help below |

## The promise from 1.0

Within a major version:

- A component that builds keeps building and behaves the same.
- A minor version may add syntax from later drafts, but only syntax that cannot change what an existing component means.
- Anything that would break an existing component waits for the next major version.

When a major version changes syntax:

- The previous major's last minor version warns about each construct that will change.
- `html-next-check` rewrites your components to the new syntax. *Planned.*
- The new major still builds library packages written for the previous snapshot, so an application can upgrade before its libraries do. *Planned.*

## Say which versions your library supports {#library-versions}

A library publishes its `.html` files, and the application's Vite plugin builds them (see [Publish a library](/html-next/ship)). The application's tools version therefore decides how your components are read, so your package says which versions it was written for:

```json title="package.json"
{
  "peerDependencies": {
    "@nextwebwg/html-next-unplugin": "^1.0.0"
  },
  "htmlNext": {
    "snapshot": "YYYY-MM-DD",
    "extensions": []
  }
}
```

- **`peerDependencies`** works today: package managers flag an application whose tools version is outside your range. This is the promise you make to your users.
- **`htmlNext.snapshot`** names the snapshot your components were written for, so a later major version can build them by those rules. *Planned:* the tools do not read it yet.
- **`htmlNext.extensions`** lists the [extensions](#extensions) your components use. The application's build will stop with an error that names any extension it has not enabled. *Planned.*

## Tell your users it is stable

Once your library or application is built on a 1.x release, you can say plainly that it is stable, even though the proposal is not:

> [!ex] For your README
> **Stable on HTML Next 1.x.** Built on Declarative HTML Components, Stage 0, snapshot YYYY-MM-DD (the snapshot your 1.x release implements). The proposal is still changing, but these components will not break within HTML Next 1.x.

Until then, say the opposite: *built on HTML Next alpha releases; expect breaking changes until 1.0.*

## Extensions {#extensions}

An [extension](https://nextwebwg.org/declarative-components/#extensions) is an optional part of the language that sits outside every Level of the proposal. Each has a one-word name, such as `transitions`.

- The Vite plugin builds an extension only when its `extensions` option lists it. Otherwise, the extension's syntax is an error (`HT024`) that names the option to add.
- The live browser runtime and Vue, React, and Svelte conversion do not build extensions. They warn and build the component without the extension.
- An extension adds code only to components that use it.
- HTMLKit will enable every extension. *Planned:* it needs HTMLKit to ship compiled components first.

The first extension, `transitions`, is at the Incubation stage: these tools implement it.

| Extension | Vite plugin | Live runtime | Vue, React, Svelte |
| --- | --- | --- | --- |
| [`transitions`](/html-next/transitions) | With `extensions: ["transitions"]` | Warns; renders without animation | Warns; converts without animation |

Next: [Publish a library](/html-next/ship) covers the rest of a library's `package.json`.
