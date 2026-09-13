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
- **`../conformance.test.ts`** — the harness. It bundles the runtime once with esbuild (iife,
  global `HtmlRuntime`) and runs the whole table against **Chromium, Firefox, and WebKit**.

## Coverage

Components/props/slots, `:attr` and `bind:` bindings and attribute serialization, consumed inert
`on:`/`on:connect`/`on:disconnect`, `$value`/`$html` output (including `$html` sanitization),
value semantics (typed equality, numeric-only arithmetic, boolean `and`/`or`, truthiness, absent
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
