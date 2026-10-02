# HTML Next in-browser conformance corpus

This directory holds the shared **`source → expected observable result`** test corpus for the
HTML Next in-browser compilation path, on the model of
[web-platform-tests](https://github.com/web-platform-tests/wpt): a single table of cases that any
implementation of HTML Next must agree with. Here it is exercised against the reference in-browser
runtime (`src/runtime.ts`, entry point `lowerDocument(root = document)`).

- **`cases.ts`** — the corpus. Each case is `{ name, source, expect }`, where `source` is full
  HTML (component definition(s) + invocation(s)) and `expect` is one of:
  - **Success** — `{ probe, result }`: after `lowerDocument()`, the `probe` (a JS function body run
    in the page, with `snapshot`, `q`, `qa` helpers in scope) returns a JSON value that must
    `deepEqual` `result`.
  - **Diagnostic** — `{ code }`: `lowerDocument()` must throw an `HtmlDiagnosticError` whose
    `.diagnostic.code` equals `code`.
  - A success case may also declare `after` steps. Each step runs a browser action, then repeats
    the same probe against a new expected result. The Vue parity suites run those steps too.
- **`../conformance.test.ts`** — the harness. It bundles the runtime once with esbuild (iife,
  global `HtmlRuntime`) and runs the whole table against **Chromium, Firefox, and WebKit**.
- **`../../../html-next-converter/tests/vue-type-parity.test.ts`** — converts every success case
  to a Vue SFC, typechecks the generated SFC and its public prop calls with `vue-tsc`, and checks
  representative invalid prop values with TypeScript errors.

## Coverage

Components/props/slots, `from:attr` and `bind:` bindings and attribute serialization, consumed inert
`on:` bindings, `$value`/`$html` output (including `$html` sanitization),
value semantics (typed equality, dimensional arithmetic, boolean `and`/`or`, truthiness, absent
fault tolerance), control flow (`$if`, `$each` with `$where`/`$sort`/`$limit`/`loop`,
`$match`/`$when`/`$else`, `$with`, structural `<template>`), live reactive declarations
(`state`/`computed`/`data`), and a representative set of diagnostics using the real stable codes
from `src/runtime.ts`.

## Running

The default `corepack pnpm test` skips the browser corpus and stays green without installed
browser engines. The repository's browser-test configuration enables the corpus explicitly:

```sh
# once, if the engines are not installed:
corepack pnpm exec playwright install chromium firefox webkit

corepack pnpm test:browser
```
