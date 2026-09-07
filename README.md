# HTML7

HTML7 is an exploration of a more declarative application language built on HTML.
It asks how far browsers can be pushed today, through compilation and a browser
polyfill, before a new platform primitive is actually required.

The project is intentionally separate from Looma. Looma can become its first demanding
component library and conformance corpus without making Looma consumers ship an
experimental runtime.

Status: early design exploration. Nothing here is a stable syntax or implementation
commitment.

## Working thesis

HTML7 should offer the declarative component authoring, template control flow, and
reactivity associated with Vue and Svelte, but as HTML—or as a deliberately evolved
HTML language—rather than as a framework-specific JavaScript dialect.

HTML should be able to express, declaratively:

- reusable templates;
- template imports;
- template control flow such as conditionals and iteration;
- typed component properties and content models;
- data sources and their parameters;
- bindings between controls, data, state, and templates;
- reactive updates;
- a vocabulary of new elements that can be lowered to today's platform.

One source language should have two equivalent execution paths:

```text
                     HTML7 source
                          |
                  parse and type-check
                          |
          +---------------+----------------+
          |                                |
  ahead-of-time compiler          in-browser polyfill
          |                                |
  Vanilla / React / Vue /       interprets the same language
  Svelte / future targets       against the browser DOM
```

See [the living design notebook](./docs/design-notebook.md) for the current model,
examples, browser questions, and unresolved decisions. Reproducible parser experiments
are recorded in [browser findings](./docs/browser-findings.md). The first proposed
language boundary is in [template expressions](./docs/template-expressions.md). Systems
we are learning from are tracked separately in [prior art](./docs/prior-art.md). Native
element/property metadata is covered by [platform contract data](./docs/platform-contract-data.md).
