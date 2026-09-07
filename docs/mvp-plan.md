---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
title: HTML Next component-generation MVP
status: early-release
---

# HTML Next component-generation MVP plan

> The HTML Next language specification and design record now live in the
> [`nextwebwg/site`](https://github.com/nextwebwg/site) repository. Paths such as
> `docs/specification.md` referenced below point to their original location during MVP
> development; this repository is the reference implementation (polyfill + converter).

## Goal Capsule

Build the smallest end-to-end HTML Next implementation that proves a component primitive can be
authored once as literal, browser-parseable HTML and projected into Vanilla DOM, React,
Vue, Svelte, generated API documentation, and a direct browser-lowering path.

The MVP proves the architecture; it does not attempt the full HTML Next application language.

## Scope Boundaries

In scope:

- the component contract schema described in `docs/specification.md`;
- a typed `defineContract()` validator;
- HTML source parsing into one framework-neutral IR;
- build-time generation of lowercase-to-canonical DOM property metadata;
- primitive component validation and code generation;
- Vanilla, React, Vue, Svelte, contract JSON, CSS, and Markdown API outputs;
- a one-shot browser runtime for initial lowering;
- a CLI that builds one or more component sources;
- a button fixture demonstrating the entire path; and
- Node and real-browser conformance tests.

Out of scope:

- arbitrary expressions or JavaScript evaluation;
- state, computed values, data sources, control flow, filters, or actions;
- reactive updates after initial browser lowering;
- behavior controllers and compound widgets;
- named slots or component composition;
- SSR/hydration;
- publishing packages or creating `nextwebwg/html` on GitHub; and
- migrating any specific component library to HTML Next.

## Key Decisions

- **KTD-1: Literal HTML source.** The canonical MVP source is an HTML file containing a
  native inert `<template component>` carrier, an optional declarative `<props>` interface,
  one native markup root, and optional `<style>`. Prop targets and the native element are
  inferred from the markup, not restated.
- **KTD-2: Contract data, not executed source.** `defineContract()` validates the data
  model programmatically; the source file itself does not execute TypeScript.
- **KTD-3: One IR.** All generators and the browser runtime use the same normalized
  contract and template node model.
- **KTD-4: Native roots.** Primitive components lower directly to the native element
  named by their contract and add no semantic wrapper.
- **KTD-5: Static property spelling.** Library build tooling generates maps from
  ASCII-lowercase lookup keys to exact DOM property names. Runtime prototype reflection
  is not the production resolver.
- **KTD-6: Explicit early-release boundary.** Unsupported reserved language features
  fail with diagnostics and are documented as coming soon.
- **KTD-7: Library-agnostic.** The fixture is a neutral `x-button`; the implementation
  and specification are independent of any specific component library.

## Requirements

### R1. Contract validation

The library accepts contract schema version 1, applies defaults, validates prop types and
targets, rejects unknown fields, rejects normalized-name collisions, and returns deeply
immutable normalized data.

### R2. Browser-equivalent source parsing

The compiler parses literal HTML using HTML parsing rules, locates the component blocks,
and produces a normalized IR. It validates one native root, default slot constraints,
literal attributes, simple prop attribute bindings, and explicit property bindings.

### R3. Static DOM property contract

A deterministic build script reads pinned DOM type data and emits interface inheritance,
tag-to-interface maps, and lowercase-to-exact property maps. Resolver tests cover
`innerhtml -> innerHTML`, `textcontent -> textContent`, and button-native properties.

### R4. Generated framework projections

One parsed component generates deterministic Vanilla, React, Vue, and Svelte source.
Each projection renders the native root, applies defaults and owned attributes, accepts
native attributes, and renders default children without a wrapper.

### R5. Generated consumer documentation

The same contract generates machine-readable normalized JSON and a Markdown API page
showing release status, summary, native element, props, defaults, targets, usage, and a
"Coming soon" limitations section.

### R6. Browser lowering

A browser module reads the same source shape from the DOM, validates it, finds matching
invocations, and replaces them with equivalent native roots. It preserves pass-through
attributes and invocation children and does not register custom elements.

### R7. CLI and repeatability

`html-next build <entries...> --out-dir <directory>` creates all selected outputs,
directories, and a deterministic manifest. A repeated build with unchanged inputs
produces byte-identical files.

### R8. Conformance evidence

Automated tests cover happy paths, contract and source failures, normalized property
resolution, deterministic generation, CLI integration, and runtime/AOT DOM parity in a
real browser. Type checking, generated-data freshness, tests, and `git diff --check` pass.

## Implementation Units

### U1. Establish package and core contract

Goal: Create an ESM TypeScript package and implement the schema, diagnostics, normalized
types, serialization rules, and `defineContract()`.

Files:

- `package.json`
- `tsconfig.json`
- `src/contract.ts`
- `src/diagnostics.ts`
- `src/types.ts`
- `test/contract.test.ts`

Dependencies: none.

Execution note: Test-first. Contract validation is the first behavior seam and becomes
the authority for every later unit.

Verification: focused contract tests and TypeScript check pass.

### U2. Generate platform property metadata

Goal: Generate compact static DOM property maps at library build time and expose one
resolver shared by compilation and browser execution.

Files:

- `scripts/generate-dom-properties.ts`
- `src/generated/dom-properties.ts`
- `src/platform.ts`
- `test/platform.test.ts`

Dependencies: U1.

Execution note: Test-first for lookup behavior; generated output itself is verified by a
freshness check rather than hand-edited assertions.

Verification: the generator is deterministic, freshness check is clean, and exact
property spelling tests pass.

### U3. Parse HTML Next components into IR

Goal: Parse an HTML source artifact, validate its blocks and template subset, and produce
the normalized component IR.

Files:

- `src/parser.ts`
- `src/template.ts`
- `test/parser.test.ts`
- `test/fixtures/x-button.html`

Dependencies: U1, U2.

Execution note: Test-first with both successful parsing and stable diagnostic codes.

Verification: parser tests cover valid component source, malformed contracts, duplicate or
missing blocks, root mismatch, undeclared bindings, property normalization, and reserved
unsupported syntax.

### U4. Generate component projections

Goal: Emit deterministic Vanilla, React, Vue, Svelte, CSS, normalized contract JSON, and
Markdown API outputs from the IR.

Files:

- `src/generate.ts`
- `src/targets/vanilla.ts`
- `src/targets/react.ts`
- `src/targets/vue.ts`
- `src/targets/svelte.ts`
- `src/targets/docs.ts`
- `test/generate.test.ts`

Dependencies: U3.

Execution note: Snapshot-first. Expected source artifacts are consumer-visible API and
should make target drift obvious.

Verification: snapshots are deterministic, contain no wrapper elements, preserve native
attribute escape hatches, and prominently label early status.

### U5. Add direct browser lowering

Goal: Interpret component definitions from a live document and lower matching invocation
elements once using the same contract rules.

Files:

- `src/runtime.ts`
- `test/runtime.html`
- `test/runtime.test.ts`

Dependencies: U3.

Execution note: Proof-first in a real browser. Compare semantic DOM snapshots rather than
format-sensitive `outerHTML` strings where attribute order is irrelevant.

Verification: Chromium, Firefox, and WebKit produce the same native root for the button
fixture; pass-through attributes and child nodes survive; no Custom Element is
registered.

### U6. Add CLI and example output

Goal: Provide a build command and check in an example component plus its generated
artifacts for inspection.

Files:

- `src/cli.ts`
- `examples/x-button.html`
- `examples/generated/**`
- `test/cli.test.ts`

Dependencies: U4.

Execution note: Integration-first through a temporary output directory. Generated
example artifacts are refreshed only after behavior is proven.

Verification: CLI integration test passes, checked-in generated output is fresh, and two
successive builds are byte-identical.

### U7. Complete public documentation and conformance gates

Goal: Make the experiment understandable and repeatable without reading implementation
internals.

Files:

- `README.md`
- `docs/specification.md`
- `docs/mvp-plan.md`
- `docs/browser-findings.md`
- package scripts and conformance configuration as needed

Dependencies: U1-U6.

Execution note: Documentation describes shipped behavior as available and every later
language feature as coming soon. It must not imply the GitHub repository has been
created or packages have been published.

Verification: all documented commands run from a clean checkout; links resolve; all
quality gates pass.

## Verification Contract

Required local gates:

```text
npm run generate:dom
npm run check:generated
npm run typecheck
npm test
npm run test:browser
npm run build:example
git diff --check
```

The exact script internals may change during implementation, but these user-facing gates
must remain stable or the plan must record the replacement before delivery.

Browser verification must use Chromium, Firefox, and WebKit. If an engine cannot run in
the environment, the final report must name the missing engine and retain the unverified
gate as incomplete.

## Test Scenarios

### Happy paths

- Parse the button definition and normalize its contract and template.
- Generate every target and inspect its native `<button>` root.
- Apply default props and explicit invocation props.
- Preserve `id`, `class`, native button attributes, ARIA attributes, data attributes, and
  children.
- Resolve `.innerhtml` to `innerHTML` through static metadata without reflection.

### Edge cases

- Boolean, number, enum, required, omitted, and default prop serialization.
- Empty default slot and mixed text/element children.
- Attribute case normalization and canonical DOM property spelling.
- Deterministic ordering regardless of object insertion order.
- Existing output directory and repeated builds.

### Failure paths

- Malformed JSON and unsupported schema versions.
- Missing, duplicate, or unknown source blocks.
- Invalid tag, native root, prop, type, target, and default.
- Case-insensitive prop/property collisions.
- Undeclared binding identifiers and target mismatches.
- `bind:` and other reserved syntax in the MVP.
- Unsafe dynamic `.innerHTML` assignment.

### Integration

- Build a source file through the CLI and consume its Vanilla module in a browser.
- Lower the same invocation through the browser runtime.
- Compare the two semantic DOM snapshots.
- Compile or parse generated React, Vue, and Svelte source with their official toolchains
  when those dependencies are present in the development environment.

## Definition of Done

- The technical specification clearly distinguishes normative MVP behavior from future
  language intent.
- Every requirement R1-R8 has an implementation and automated evidence.
- The button fixture generates Vanilla, React, Vue, Svelte, CSS, contract JSON, and API
  Markdown from one HTML source.
- The browser runtime lowers that same source without Custom Elements or dynamic code
  evaluation.
- Property bindings use generated lowercase-to-canonical static data.
- Generated output is deterministic and freshness-tested.
- Node and three-engine browser suites pass.
- Type checking and whitespace checks pass.
- No package, repository, release, or remote is published as part of the MVP.

