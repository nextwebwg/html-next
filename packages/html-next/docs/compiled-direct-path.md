# Compiled components

The build plugin (`@nextwebwg/html-next-unplugin`) and `html-next build` compile every component the parser accepts to direct DOM code: a cloned template plus the exact
updates its state, conditions, lists, props, slots, invocations, data reads, contexts and controller
need. There is no option to turn on and no general-runtime fallback. Compiled components have the live
runtime's semantics, which parity suites hold them to, and the generated module imports only the
`@nextwebwg/html-next/generated-runtime` helpers its features use. Component behavior is defined by
the [proposal](https://nextwebwg.org/declarative-components/); this page describes how the tooling
compiles it.

Measured results and the remaining performance work are tracked in
[rendering-performance-status.md](./rendering-performance-status.md).

## Architecture

```
authored .html ──parse──▶ ComponentDefinition ──blockPlan──▶ blocks ──emitBlocks──▶ native module
```

- **Planner and emitter** (`src/targets/vanilla-blocks.ts`). `blockPlan` lowers a definition to
  blocks: a prototype spec, binding sites reached by `firstChild`/`nextSibling` paths computed at
  build time, one guard group per changed-roots mask, and regions for `$if`, `$match`, `$each`,
  `$html`, slots and invocations. Expressions lower to JavaScript that matches the interpreter;
  bindings compare converted output before writing. `emitBlocks` writes the module.
- **Helpers** (`src/generated-runtime.ts`, `sideEffects: false`, named imports). `buildTemplate`
  builds a prototype once with `createElement`/`setAttribute` (no HTML or Trusted Types sink), then
  rows and branches clone it. `toText`, `toAttribute` and `truthy` are re-exported from
  `expression.ts`, so conversions are shared with live, not copied. `conforms` and `compactTypeAt`
  check state writes against compact declared types.
- **Typed boundaries** (`src/type-checks.ts`). Each declared prop and event type compiles to the
  checks it uses (`checkString`, `checkFormat("keyword", keywordFormat)`, `checkList(…)`, …); the live
  type system builds its own checks from the same combinators, so messages and canonical values are
  one implementation. Compiled props carry their rule, checks, text form and compact type, and share
  `propsValidity` with live. The type-expression parser, the literal parser, unused formats and the
  color keyword table are never bundled.
- **`KeyedList`** (`src/keyed.ts`). Rows are their element (no per-item comment markers). A
  reconcile trims the common prefix and suffix and swapped ends, checks every key before any DOM
  mutation (HR004 for duplicates, HB001 for `undefined` items), removes adjacent stale rows with
  `replaceChildren` when the region owns its parent, otherwise `Range.deleteContents()` or
  `remove()`, inserts fresh rows in forward order, and moves retained rows outside the longest
  increasing run with `moveBefore` where the browser has it, otherwise `insertBefore`. Keys are
  memoized; rows whose item changed are re-keyed and patched in one fused update. Rows of several
  nodes use ranged subclasses. Key-aligned equality class bindings touch only the old and new
  selected rows.
- **Compiled-root handle and host** (`attachGeneratedController`). Every root has a handle that the
  live runtime's `getComponentHost`, `inspectInstance` and `serializeRenderedForm` read, and a host
  with the live host's contract. Root values are stored raw. Writes through `host.state` and nested
  facades are checked with `conforms` and warn HR007 once per definition and path; computeds,
  contexts and data are read-only views. Changed roots are marked in a bitmask and written raw objects
  in a map. The template render is one priority-1 job on the instance's `ReactiveScheduler`, between
  controller computeds and effects. The factory renders initial state at construction, calls the
  controller's default export on first connect, pauses on disconnect and re-renders everything on
  reconnect, as the live runtime does.
- **Lifecycle coordinator and observers.** Every document has one coordinator slot and one
  MutationObserver hub, shared by the live runtime, compiled roots and the framework targets'
  controller hosts. Compiled output installs the indexed coordinator
  (`src/generated-lifecycle-index.ts`), which holds registered roots' lifecycle records through
  `WeakRef`s pruned by a `FinalizationRegistry`. With up to 32 roots it synchronizes a single changed
  root without walking the mutated subtrees; otherwise it runs the same walk, with the same light-DOM
  scope. When the live coordinator installed first, compiled roots get the exact walk.

The [native runtime audit](./native-runtime-audit.md#compiled-components) records the native
mechanisms each helper composes and the remaining gap: the platform has no keyed reconciliation and no
reactive binding of template parts.

## Hydration

A module generated with `hydrate: true` also adopts server output: `create<Name>(options, html, root)`
takes a server-rendered root, in the [rendered form](https://nextwebwg.org/declarative-components/rendered-form)
that `renderComponents` and `serializeRenderedForm` write, and binds that DOM in place instead of
cloning its prototype. Modules generated without the option are unchanged, and every adoption helper is
its own `generated-runtime` export, so only hydrating bundles carry them.

| Need | Native mechanism composed | Remaining gap filled by code |
| --- | --- | --- |
| Find the nodes to bind | The parsed server DOM; `firstChild`, `nextSibling`, `localName` | `adoptTree` walks a block's prototype spec beside the server nodes, steps over region contents (comment and processing-instruction marks), inserts the empty `Text` a `""` value left out, and returns each prototype node's server node |
| Instance values | `getAttribute`, `JSON.parse` | The `data-html-next-instance` record restores props, prop inputs and state, through the live decoder, then the attribute is removed |
| Conditions, lists, slots | The marks already in the DOM | Each region adopts its server content on its first render; rows adopt their item ranges, slots their projected nodes, fallback or scoped rendering |
| Nested components | `data-component` on each server root | An invocation adopts the server root where its placeholder would be; a parent binds what it projected inside the child's slot ranges |
| Edits before startup | `value`, `checked`, `selectionStart`/`selectionEnd`, `defaultValue`, `defaultChecked`, `defaultSelected` | Control values and selection are captured before the first render and restored after it; `data-html-next-form-defaults` restores the template's defaults |
| Markup that changed before startup | `remove()`, `insertBefore` | A block whose server nodes do not match its spec is created afresh in place of them; the blocks around it are still adopted |

| Connection order | `isConnected`, `compareDocumentPosition` | Every root a hydration adopts connects once the outermost one has finished, in document order, so a context's reader finds its provider and each controller sees a complete tree |

Adoption keeps every server node it binds in place, so focus, selection, media and frames are
undisturbed. Each binding writes once on the first render, as live hydration's effects run once
each; the server already shows the same value, so nothing visible changes. An `$html` element or
range renders its sanitized content again, as the live runtime's does. A consumer's `<template slot>`
written in the document, rather than in a compiled component, renders only through the live
delivery's parser, when created or hydrated alike.

`compiled-hydration.test.ts` holds hydration to the live runtime's over the cases in
`hydration-fixtures.ts`, rendered by `renderComponents`: node identity, the consumed records, inspected
instances and markup before and after interaction, retained rows, parent bindings, edits made before
startup, controllers, and markup that changed before startup. `server-hydration.test.ts` runs the same
cases in Chromium, Firefox and WebKit.

## Owner decisions (2026-10-06)

These decisions govern compiled output:

- **Target.** The gated target is the Vite-compiled output (unplugin to the vanilla target) at
  0.99× or less of Solid, Vue and React Hooks each; Svelte is reported, not gated. Experiments start
  from the current improved state, never the original baseline.
- **No bundle bloat.** Size gates hold the compiled entry and every fixture; a raise is small and
  states its reason.
- **Coverage.** Everything the live runtime supports must work when compiled with Vite, each feature
  with live-versus-compiled parity tests.
- **Rows and reads.** Row bindings may be evaluated in one fused update per row, keys may be
  memoized, and an outer scalar change may re-evaluate only affected rows. Getter read counts and
  repeated warnings for unchanged results are not a contract.
- **DOM shape.** Rows may omit per-item comment markers (re-synthesized when serializing for
  hydration), and `$value` may update the existing Text node's data.
- **Ordering and diagnostics.** Replacing a whole list with all-new keys may run old rows' cleanups
  before new rows' first effects. Warnings may name the last path used to reach an object. The
  MutationRecord sequence of a partial reorder is not a contract; the final DOM and node identity are.
- **Host.** Writes through `host.state` store raw values. Facade identity is per raw object and
  declared type. The compiled factory renders initial state at construction. Fresh rows may be
  inserted as one fragment per run.
- **Not granted.** The lifecycle observer keeps today's exact light-DOM scope. All other semantics
  stay exact: validation for every evaluation that runs, HR004, mutable keys, pause, resume and
  reconnect, hydration adoption, serialization, no retention (006) and events.
- **Default.** Compiled output is the only Vite output (2026-10-07): the option, the general-runtime
  fallback and the smaller emitters that did not match live were removed.
- **Speed over bytes** (2026-10-07). Keep bytes under control, but take a speed improvement whose
  byte cost is small.

## Bytes

Gzip bytes for one component compiled alone; an application pays the shared support once per graph.

| Measure | Size |
| --- | ---: |
| Benchmark entry through Vite (unplugin test build, gzip-6, controller included) | 8,620 B |
| `controller-keyed` `measure:runtime` fixture (gzip-9, controller external) | 8,140 B |
| `static-card` fixture (gzip-9) | 6,875 B |
| `prop-button` fixture (gzip-9) | 11,287 B |
| Same, before prop types compiled to their own checks | 18,325 B |
| General-runtime output that compiled components replaced | about 39,500 B |

Gates: the unplugin test fails the benchmark entry above 8,625 B gzip-6, and `measure:runtime`
fails each fixture above its ceiling or when the interpreter, a parser, the type system or the
formatter contributes any bytes. A ceiling rises only by a small amount with its reason recorded
beside it.

## Measuring

- `pnpm measure:runtime` reports every fixture's size.
- `pnpm measure:frameworks` builds the harness's Vite entry and runs a sweep;
  `pnpm verify:frameworks --base=<ref>` gates it against a base revision, and
  `pnpm smoke:frameworks` checks it in Chromium against the live entry. See
  [the framework comparison benchmark](./framework-benchmark.md).
- The parity suite runs one action script through the live runtime and through compiled output and
  compares DOM, row identity, warnings, errors and lifecycle order: `tests/vanilla-blocks.test.ts` in
  jsdom (multi-component graphs included) and `tests/target-runtime.test.ts` in Chromium, Firefox and
  WebKit. `tests/compiled-interop.test.ts` holds inspection, serialization and live hydration of
  compiled roots to live's.
