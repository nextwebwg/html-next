# Compiled direct path (experimental)

`GenerationOptions.directExtend`, exposed by `@nextwebwg/html-next-unplugin` as
`experimentalDirectExtend`, compiles components with a controller, declared state, `$if` and keyed
`$each` to straight-line DOM code instead of the general-runtime fallback. It is off by default.
Without it, generated modules are byte-identical to those generated before the option existed, and
no existing size fixture grows. Component behavior is defined by the
[proposal](https://nextwebwg.org/declarative-components/); this page describes how the tooling
compiles it.

The direct path is meant to cover everything the live runtime supports. A component that uses a
feature it does not cover yet is not unsupported: it keeps today's general-runtime fallback, with
exact live behavior, until that feature is added (the planner marks those spots `notYetDirect()`).
Direct helpers next to the general runtime would only add bytes, so the unplugin applies the option
to a whole graph or not at all. When any component in the graph still needs the general runtime,
the whole graph builds exactly as without the option, and the build manifest's
`directExtend: { applied, runtimeComponents }` names the components that kept it there.

## Architecture

```
authored .html ──parse──▶ ComponentDefinition ──generateVanilla(…, directExtend)
  ├─ older direct paths (primitives, scalar props)   unchanged
  ├─ blockPlan / emitBlocks                          only with directExtend, when the above decline
  └─ general-runtime fallback                        unchanged, byte for byte
```

- **Planner and emitter** (`src/targets/vanilla-blocks.ts`). `blockPlan` lowers a definition to
  blocks: a prototype spec, binding sites reached by `firstChild`/`nextSibling` paths computed at
  build time, one guard group per changed-roots mask, and regions for `$if` and `$each`. Bindings
  compare converted output before writing. `emitBlocks` writes the module; it imports only the
  `@nextwebwg/html-next/generated-runtime` helpers its features use.
- **Helpers** (`src/generated-runtime.ts`, `sideEffects: false`, named imports). `buildTemplate`
  builds a prototype once with `createElement`/`setAttribute` (no HTML or Trusted Types sink), then
  rows and branches clone it. `readMember` is the interpreter's member read over raw values.
  `writeText` writes `$value` through `Text.data` on a sole Text child, and `textContent` for `""` and
  foreign content. `writeAttribute`, `clearRegion` and `trackContainer` cover attributes, `$if`
  teardown and rows that show a list or object. `toText`, `toAttribute` and `truthy` are re-exported
  from `expression.ts`, so conversions are shared, not copied. `conforms` and `compactTypeAt` check
  writes against compact declared types; the type system and its parser are never shipped.
- **`KeyedList`** (`src/keyed.ts`). Rows are their element (no per-item comment markers). A
  reconcile trims the common prefix and suffix and swapped ends, checks every key before any DOM
  mutation (HR004 for duplicates, HB001 for `undefined` items), removes adjacent stale rows with
  `replaceChildren` when the region owns its parent, otherwise `Range.deleteContents()` or
  `remove()`, inserts each run of fresh rows as one fragment, and moves retained rows outside the
  longest increasing run with `moveBefore` where the browser has it, otherwise `insertBefore`. Keys
  are memoized; rows whose item changed are re-keyed and patched in one fused update. The start
  anchor carries a region tag for marker re-synthesis (M3). `KeyedList.fragment` and
  `KeyedList.moveBefore` are static screening knobs, both `true` by default.
- **Compact controller host** (`attachGeneratedController`). Root values are stored raw. Writes
  through `host.state` and nested facades are checked with `conforms`, warn HR007 once per
  definition and path (naming the last path that reached an object), and mark changed roots in a
  bitmask and written raw objects in a map. Facades are one `Proxy` per raw object and declared
  type, with shared traps. The template render is one priority-1 job on the instance's
  `ReactiveScheduler`, between controller computeds and effects, and controller effects use the
  reactivity dependency graph through `trackProperty`, `notifyPropertySet` and
  `notifyPropertyDelete` (factored out of the live reactive traps). The factory renders initial
  state at construction, calls the controller's default export on first connect, pauses on
  disconnect and re-renders everything on reconnect, as the live runtime does.
- **Lifecycle coordinator.** Every document has one coordinator slot, shared by the live runtime and
  all generated output; whichever installs first serves every root in that document, so two
  coordinators never disagree. Older generated output installs the plain coordinator
  (`src/generated-lifecycle.ts`). Direct-extend output installs the indexed one
  (`src/generated-lifecycle-index.ts`), which holds registered roots through `WeakRef`s pruned by a
  `FinalizationRegistry`. With up to 32 roots it synchronizes a single changed root without walking
  the mutated subtrees; otherwise it runs the same walk, with the same light-DOM scope. Only
  direct-extend output imports it, so other generated output does not grow. When another coordinator
  installed first, direct-extend roots get the exact walk without the fast path.

The [native runtime audit](./native-runtime-audit.md#direct-extend-generated-components-experimental)
records the native mechanisms each helper composes and the remaining gap: the platform has no keyed
reconciliation and no reactive binding of template parts.

## Owner decisions (2026-10-06)

These decisions govern compiled output:

- **Target.** The gated target is the Vite-compiled output (unplugin to the vanilla target) at
  0.99× or less of Solid, Vue and React Hooks each; Svelte is reported, not gated. Experiments start
  from the current improved state, never the original baseline.
- **No bundle bloat.** The compiled entry must shrink at every milestone. Output without the option
  and every existing size fixture must not grow. Byte-heavy changes bought for marginal speed are
  rejected.
- **Coverage.** Everything the live runtime supports must work when compiled with Vite. The
  general-runtime fallback is transitional; the direct path grows to full coverage, each feature
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
- **Default.** The option may become the default Vite output after full parity (M3).

## Covered today

- Components with a controller and 1–30 `<state>` declarations whose types have a compact form that
  rejects `undefined`, with literal initial values.
- `$if` with a root test, nested in other `$if` bodies; keyed `$each` with item-only keys and rows
  that read the item, roots and undeclared root paths.
- One-way non-URL attributes, `class:` toggles, `$value` and a lone `{expr}` text interpolation.
- Expressions: literals, roots, the item, one-step item paths, undeclared root paths, `=`, `!=`,
  `and`, `or`, `not` and `? :`.

## Coverage plan

Estimated gzip-6 bytes are paid only by graphs that use the feature: once per graph for shared
helpers, per component for generated code.

| Feature | Milestone | Est. bytes |
| --- | --- | ---: |
| Components without a controller that use `$if`/`$each` | M2 | +0.1 KB |
| `<computed>` (read-only roots) | M2 | +0.15 KB |
| `<handler>` (`set`, guards, `dispatch`, `focus`, `validate`) | M2 | +0.2 KB |
| `<event>` declarations (typed detail, HR002, init flags) | M2 | +0.3 KB |
| Untyped or `unknown` state (HB001 read guard) | M2 | +0.1 KB |
| Format terminals, `keyword`, keyword literals, separated lists, trusted types, `function`, `event`, `selected`, constrained null-accepting bases | M2 | +0.1–0.3 KB each |
| Non-literal or nonconforming initial values | M2 | ~0 / +0.2 KB |
| `:host-state()` state attribute | M2 | +0.2 KB |
| More than 30 roots | M2 | +0.1 KB |
| `style:` bindings | M2 | +30 B |
| URL attributes (`href`, `src`, …) | M2 | +0.2 KB |
| Property bindings | M2 | +40 B |
| Two-way bindings and form controls | M2 | +0.4 KB |
| Mixed text interpolation | M2 | +40 B |
| `on:` events and modifiers, including in rows | M2 | +0.2 KB |
| `$ref` (static and iterated) | M2 | +0.15 KB |
| SVG and MathML | M2 | +0.15 KB |
| `script`, `template`, `iframe`, `object`, `embed`, `link`, `style`, `meta`, `base`, `noscript` | M2/M3 | small |
| Bound `class` together with `class:` on one element | M2 | 0 |
| Regions inside `select`/`datalist`/`optgroup` | M2 | +0.1 KB |
| Arithmetic, unary minus, comparisons, `^=`/`$=`/`*=`, built-in calls | M2 | +0.3–0.6 KB |
| `format()` / Intl formatting | M2 | +4–5 KB |
| Index access, object and array literals | M2 | +0.1 KB |
| Dimension arithmetic | M2 | +0.4 KB |
| Declared nested root paths (reference prepass) | M2 | +0.1 KB + messages |
| Item paths deeper than one step | M2 | 0 |
| `$if` tests reading nested paths or containers | M2 | +0.2 KB |
| Keys whose truthiness reads an item-reached container | M2 | 0 |
| Unkeyed `$each` | M2 | +0.1 KB |
| Index alias, `loop` record | M2 | +0.1 KB |
| `$where`, `$sort`, `$limit` | M2 | +0.4 KB |
| Keys reading roots | M2 | 0 |
| Nested flows inside rows | M2 | +0.3 KB |
| `$with`, non-root `$match`/`$when`/`$else` | M2 | +0.2 KB |
| Props (scalar, enum, structured, `selected`, bounds) | M3 | +1.2 KB |
| `<data>` declared reads | M3 | +2–3 KB |
| `<context>` provide/consume | M3 | +0.4 KB |
| `$html` (sanitizer imported only when used) | M3 | +2 KB |
| Custom elements, `is=` | M3 | n/a |
| Component invocations | M3 | +0.3 KB |
| Slots (default, named, dynamic, scoped, fallback) | M3 | +0.3 KB |
| Root `$match` | M3 | +0.2 KB |
| `getComponentHost`, `inspectInstance`, `serializeRenderedForm` on compiled roots | M3 (runtime side) | live +0.3 KB |
| Item-marker re-synthesis for hydration of compiled rows | M3 (runtime side) | live side |
| Registry registration of compiled definitions | M3 decision | 0 |
| Coordinator fast path when the live coordinator installed first (`runtime.ts` imports the generated one) | M3 | live −0.4 KB |
| Coordinator fast path above 32 roots | M3 | +0.1 KB |
| Older direct output with a lifecycle routed through the indexed coordinator (today a graph with both bundles both coordinators) | M3 | about −180 B gzip-9 in such graphs |
| Shared per-module host objects before 1k compiled child instances | M3 | ~0 |

Hydration adoption of server markup stays with the live runtime by design.

## Bytes

| Measure | Size |
| --- | ---: |
| Benchmark entry through Vite with the option (unplugin test build, gzip-6, controller included) | 8,044 B (21,495 B raw) |
| Same entry, general-runtime fallback | 38,939 B (126,392 B raw) |
| Benchmark harness Vite entry with `--direct-extend` (ES2022 target, gzip-6) | 8,292 B (22,165 B raw) |
| Same harness entry without the option | 39,248 B (127,066 B raw) |
| `controller-keyed` `measure:runtime` fixture (gzip-9, controller external) | 7,528 B |
| `prop-button` fixture, output without the option (gzip-9) | 2,044 B (2,045 B on `main`) |
| Live distributable delta from the reactivity exports (gzip-9) | +32 B |

Gates: the unplugin test fails the direct benchmark entry above 8,100 B gzip-6, and
`measure:runtime` fails `controller-keyed` above 7,754 B gzip-9 or when the interpreter, a parser,
the type system or the formatter contributes any bytes. These ceilings are non-increasing: M2 and
M3 may not raise them, and each ratchets down when the entry shrinks. Live runtime growth is capped
at +2 KB gzip in total.

## Measuring

- `pnpm measure:runtime` reports the `controller-keyed` fixture and the size of every other fixture.
- `pnpm measure:frameworks --direct-extend` builds the harness's Vite entry with the option and runs
  a sweep; `pnpm verify:frameworks --direct-extend --base=<ref>` gates it against a base revision
  built with the option too (a revision that predates it is recorded as `"unsupported"`), and
  `pnpm smoke:frameworks --direct-extend` checks it in Chromium against the live entry. See
  [the framework comparison benchmark](./framework-benchmark.md).
- The parity suite runs one action script through the general runtime and the direct path and
  compares DOM, row identity, warnings and lifecycle order: `tests/vanilla-blocks.test.ts` in jsdom
  and the "generated Vanilla direct-extend" describe of `tests/target-runtime.test.ts` in Chromium,
  Firefox and WebKit.

## Path to default-on

1. **M2** widens coverage one feature per commit, each with its byte line, parity fixtures and a
   planner test; the benchmark entry stays at or below its ceiling.
2. **M3** reaches parity: props, slots and component invocations compiled; `getComponentHost`,
   `inspectInstance` and `serializeRenderedForm` reading compiled handles, with item markers
   re-synthesized; the live runtime importing the generated coordinator. Gates: compiled entry at or
   below its ceiling, live net growth at or below zero, a serialization round trip (compiled, then
   hydrated live) equal to the live original, and the full parity suite green in three engines.
3. With the owner's approval after M3 parity, `directExtend` becomes the default Vite output;
   examples and snapshots are regenerated with `build:example` and their diffs reviewed.
