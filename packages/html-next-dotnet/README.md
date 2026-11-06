# HTML Next for .NET

Experimental native .NET rendering slice. Compile a component once, keep the returned template, and render it repeatedly with request data. The initial implementation produces inert HTML and measures template/data-binding cost against Fluid and Node.js.

The component language is defined by the [public proposal](https://nextwebwg.org/declarative-components/). This package is tooling under development; it does not yet implement the complete language or browser hydration.

## Use a retained template

Requires .NET 10. Reference `src/HtmlNext/HtmlNext.csproj` from a local consumer. Package publication is disabled.

```csharp
using HtmlNext;

// Create once during application startup.
var card = HtmlNextCompiler.Compile("""
    <template component="x-card">
      <defs><prop name="title" type="string" required>Card title.</prop></defs>
      <article><h2>{$title}</h2></article>
    </template>
    """, "card.html");

// Reuse for each request. Values are read from exact property names.
var html = card.Render(new { title = "Quarterly report" });
```

The compiler accepts source text, so applications can load files or embedded resources before compiling. A template is immutable and safe to share across concurrent renders. Input values, normalized collections, loop bindings, and output buffers belong to one render. The application must avoid mutating supplied objects during that render.

`Render` returns a complete string. `Write` accepts a `TextWriter`. Both accept cancellation; a writer can contain partial output when a later write or cancellation fails. The library leaves the caller's writer open.

Null and omitted inputs use their declared defaults, or read null when no default exists. A non-null default keeps the accepted value non-null; without a default, the implicit default is null. `required` reports validity and does not supply a default. Empty strings, zero, and false remain present. A missing required input or a value of the wrong type reports through the optional `onDiagnostic` callback and rendering continues with the default or null. Both output APIs report each binding failure once. Compilation errors, cancellation, application getter failures, and output writer failures remain exceptions.

`Render` binds and validates inputs once, counts the output over that snapshot, and fills one exact-size string. Counting does not call application getters or enumerate application data again. Numeric output uses stack-based formatting. `Write` makes one output pass to the supplied writer. Neither path retains pooled output buffers between requests. Diagnostic paths are prepared during compilation rather than constructed for every row.

Applications writing directly to a response can use `Write` to avoid allocating the complete HTML string.

## Load a component graph

`CompileResource` compiles every carrier in supplied source text. Use `CompileAsync` when resources declare `<link rel="component">` dependencies. The application resolves each authored reference relative to its importer and returns a canonical identity, source text, and optional revision. A resolver can read files, embedded resources, or application-managed package sources.

For files:

```csharp
static async ValueTask<HtmlNextSource> ResolveFile(
    string specifier, string? referrer, CancellationToken cancellationToken)
{
    var path = Path.GetFullPath(referrer is null ? specifier
        : Path.Combine(Path.GetDirectoryName(referrer)!, specifier));
    return new(path, await File.ReadAllTextAsync(path, cancellationToken));
}

var graph = await HtmlNextCompiler.CompileAsync(["/app/components/page.html"], ResolveFile);
var page = graph.Template("x-page");
var html = page.Render(new { title = "Quarterly report" });
```

Compilation deduplicates canonical resources, handles cyclic dependency links, rejects duplicate component tags, and checks component calls even in initially hidden branches. Each source's identity, revision, UTF-8 SHA-256, and resolved dependency identities are available through `graph.Sources`. Conflicting content or revisions under one canonical identity fail compilation. Retain the graph or its templates; rendering uses the compiled plans without consulting the resolver. Failed or cancelled compilations leave no shared failed-cache entry.

Basic component calls lower to the callee's native output. Written props convert during compilation; `from:` props bind from the caller's scope. Child props keep their own defaults and types, including structured field layouts. Buffered rendering retains each child input snapshot between its counting and writing passes, so binding diagnostics occur once. Writer rendering makes one pass. Child snapshots and scopes belong to the request, including recursive and repeated instances. Deep expansion reports an execution-stack resource exception before exhausting the host's CLR stack.

Resource-level and direct carrier metadata (`title`, `meta` without `http-equiv`, and ordinary metadata links) is ignored by component rendering. Only resource-level component dependency links reach the resolver. Active resource content, policy metadata, HTML Imports, and executable metadata attributes fail compilation.

Projection plans retain the consumer's lexical bindings. Default and named outlets choose assigned nodes or fallback; an empty text node counts as assigned. Conditional and repeated consumer content participates in that selection, and `<template $slot>` uses the same outlet plan. Consumer `<template slot>` bodies render on demand and remain as inert source in serialized carriers. Unused plain content also remains in a carrier, with component setup deferred until placement. Delegated roots write their carriers in outer-to-inner order. These operations stream into the same counting and writing passes without building a per-request DOM.

An unplaced component's placeholder retains its caller's bound props and rendered children. Caller-owned text, attributes, conditions, loops, fragments and forwarding outlets run inside the carrier; the callee's state initialization and required-input diagnostics wait for placement. Module specifiers remain build metadata. Invalid or waiting prop bindings retain written literal attributes. Available null and missing field values remove them. Original lazy slot templates retain their source, including their directives.

Scoped outlets compile their declared props into the same immutable plans. Written values and constant bindings convert once during compilation; dynamic inputs bind once per placement and buffered rendering reuses that snapshot. A supplied null, missing value or rejected type takes the declared default, or null. An invalid numeric expression starts at that default/null. An omitted optional prop without a default leaves the consumer's outer binding visible. Consumer template guards read their original scope; projected bodies read the outlet's supplied props. Fallback content reads the receiving component's scope. Scoped props require consumer `<template slot>` content. Repeated outlets and concurrent requests keep separate values, and type-rejection diagnostics are deduplicated per authored outlet and prop within a render. Accepted-child declarations (`accepts`/`as`) and `<slot of>` remain implementation work.

Compilation validates each component's `$ref` names, including hidden and unused content. Authored duplicate names fail compilation; alternative native roots in a root `$match` may reuse a name. Rendered nodes omit the consumed directive, while original inert template bodies retain it for client adoption. Reference validation adds no request-local values or HTML records. Browser module references stay available through `graph.Modules` and `template.Module` for client builds.

## Implementation status

The compiler currently renders component graphs whose definitions have a native root or native root choices in a bare `<template $match>`. It handles typed props, literal and expression-initialized state, forward-referenced computed declarations, pure expressions in text and `$value`, truthy `$if` guards, nested `$each` with `$where`, `$sort`, `$limit` and `$key`, lexical `$with` aliases, and first-matching `$match` arms. A nested `<template>` renders its children without a wrapper. A guard around an iteration tests its enclosing scope; `$where` tests each item. Text escapes apply to authored text before interpolation, so returned strings are never parsed again as expressions.

An iteration can bind an index with `$each="item, index of $items"`. The optional index alias reads the row's zero-based position after filtering, stable sorting and limiting. Nested iterations retain their enclosing indices and aliases. A list's `.length` reads the size of that supplied list. Numeric sort keys compare numerically; other keys use the current .NET culture's text comparison. Align host locales when comparing with Node's default-locale sort. Keys distinguish scalar types and retain record/list identity; repeated keys fail the render. Getter snapshots and compiled plans remain reusable, and an iteration that does not read its index reserves no index slot. This inert rendering path does not yet emit keyed hydration records.

Expression compilation supports literals, paths and computed indices, arithmetic, dimensions, typed comparisons, boolean operators, conditional values, and the implemented `abs`, `round`, `min`, `max`, `clamp`, `default`, `concat`, and `join` functions. The current native types include `string`, `keyword`, `number`, `integer`, `boolean`, `length`, `percentage`, `duration`, and compact or expanded nested list/object declarations. Optional fields and open objects preserve their actual field presence. Unknown values in state or open fields keep shared references within a render and snapshot application getters once; declared prop types require an HTML attribute form, matching the JavaScript compiler. Props require descriptions. Inputs may be POCOs, dictionaries, structs, or `JsonElement` values. POCO getters are cached as delegates; rendering does not invoke property getters through reflection on each row.

Literal state is initialized separately for each component instance. A state declared with `from` seeds from available inputs, including later declarations, and keeps its own copy of records and lists. Copies preserve shared references and cycles within the draft. An unavailable or wrong-typed seed leaves the state waiting; a valid null, empty string, zero, or false can initialize it. Derived declarations evaluate and cache their actual reads within the request, so unused conditional branches do not create dependency cycles. An actual cycle reports a source-associated error when read. `default(...)` can select an available fallback for an unavailable declaration. Non-finite arithmetic results are invalid and leave the destination at its default/null. An invalid result cannot be rescued by `default(...)`, which handles absence instead.

`template.Validate(inputs)` reports root prop validity without rendering. Scalar `values`, numeric `min`/`max`, text `minlength`/`maxlength`, and `required` constraints are supported. Accepted inputs outside these constraints still render, matching the JavaScript prop boundary. Validation reports constraint failures separately; `Render` reports missing or nonconforming inputs through its diagnostic callback.

Event and request declarations are checked during compilation without reading application inputs or adding HTML. Their payloads can use compact or expanded object/list shapes, `unknown`, and native `event` types. Request answers use either `returns` or one typed `<returns>` child. Compilation checks names, duplicate declarations, the reserved `responder` name, event/request collisions, and request function names that collide with props. JavaScript-only payload types remain interface metadata; browser code owns event dispatch and request handling. Pattern constraints and additional value formats remain implementation work.

Dynamic `from:` attributes support strings, numbers, boolean presence and space-joined lists. Enumerated boolean attributes, including `aria-*`, preserve the strings `true` and `false`. URL attributes omit executable schemes after stripping ASCII controls and whitespace for the scheme check. Raw content sinks and executable event targets are rejected. SVG bindings use the HTML parser's attribute-name adjustments; literal and bound foreign attributes preserve their qualified names. The [public binding proposal](https://nextwebwg.org/declarative-components/bindings/#how-a-bound-value-serializes) defines the language behavior.

An attribute can have both a literal value and a `from:` binding. An invalid initial result retains that literal, while an accepted value replaces it. Null and absence remove it, as does false for ordinary attributes. An unsafe URL also removes it. Literal URL validation still applies when a binding targets the same attribute. Fallback text is escaped during compilation and reused by both output APIs.

The native attribute tables are generated from the JavaScript owners in `expression.ts` and `sanitize.ts`. Run `corepack pnpm exec tsx packages/html-next/scripts/generate-attribute-rules.ts` after changing those tables; `check:generated` verifies both languages. Shared attribute fixtures check full .NET `Render`/`Write` output and Node's authored attributes. Component-owned validity and hydration records remain outside this fixture comparison and still need native implementation.

AngleSharp supplies HTML parsing, table structure, and foreign-element namespaces; a handwritten expression/type frontend checks and lowers values into reusable plans. HTML parse errors and unimplemented features produce source-associated errors. The application supplies source resolution during compilation. Rendering uses retained in-memory plans; component JavaScript execution remains separate.

Full prop/type validation (including remaining structured prop interoperability, nested validity paths and additional scalar formats), state availability across preparation and hydration, additional declarations and loop modifiers, invocation attribute forwarding, accepted-child projection, CSS compilation, Intl-compatible formatting, preparation snapshots, and hydration remain implementation work. Select elements are rejected because the parser can discard their unsupported children before component validation. Trimming and Native AOT are not qualified. `graph.Modules` and `template.Module` retain declared module specifiers and canonical source IDs for client builds. Deployed-asset validation and hydration records still need integration. The .NET runtime remains separate from the JavaScript build tools that will supply client assets. Structured state seeds retain their actual field layout. Typed references check each read, so one wrong-typed field stays inert while conforming siblings remain readable; nested constraints do not refuse the whole seed. Direct prop normalization and structured child-prop interoperability still need complete qualification. The current simple benchmark fixtures do not characterize nested-component or state-initialization allocations.

## Use built style assets

Build the component graph with the native HTML Next unplugin and keep its emitted stylesheets and `html-next.manifest.json`. Load that manifest once before compiling the matching .NET source graph:

```csharp
var assets = HtmlNextServerAssets.FromManifest(
    await File.ReadAllTextAsync("wwwroot/html-next.manifest.json"));
var graph = await HtmlNextCompiler.CompileAsync(
    ["/app/components/page.html"], ResolveFile, assets: assets);
var html = graph.Template("x-page").Render(model);
```

Resolve `graph.Stylesheets` beneath the application's deployed asset base and include each stylesheet once in the document. `CompiledTemplate.Stylesheets` exposes the same build filenames when retaining a single template. The compiled plan writes canonical component identities and the root-value tokens requested by the shared CSS compiler. Those tokens cover declared prop selectors, state selectors and delegated roots; nested components retain their own style boundary. Both `Render` and `Write` reuse these immutable assets across requests.

The reader validates server asset version 1, unique source/component entries and emitted stylesheet availability. Compilation checks each component's source fingerprint against the manifest. A stale source or incompatible manifest raises `HNCS006`. Source identities may differ between the build and deployment; matching uses the declared component tag and the complete source-content fingerprint.

Standalone CSS compilation and native validation of imported stylesheet-source fingerprints remain unfinished. This asset path does not complete native scoped projection, preparation, rendered-form or hydration support. Those features still need qualification against the public proposal and complete Looma catalog.

## Verify and measure

Run from the repository root:

```sh
corepack pnpm test:dotnet
corepack pnpm exec tsx packages/html-next-dotnet/benchmarks/node.ts --validate
corepack pnpm measure:dotnet --filter '*'
corepack pnpm measure:dotnet:node
corepack pnpm measure:dotnet --allocations
```

The .NET benchmark uses BenchmarkDotNet with allocation diagnostics. It compares cached HTML Next plans and cached Fluid templates, with fresh per-render input binding and complete string output on both sides. Each case validates full output against an independently constructed expectation before timing and prints template, model, and output hashes. The benchmark warms POCO accessors before measurement.

The Node benchmark is an inert adapter using HTML Next's production parser, type checks, and expression evaluator. It generates the same validated output from the same fixture data. It is not the public worker/DOM server renderer, a generated Node SSR backend, or a measurement of browser hydration. Its results are diagnostic comparisons of this adapter with the C# rendering plan, not a general C# versus JavaScript speed claim. Node allocation measurements and concurrent HTTP serving are still outstanding.

Use an otherwise quiet machine and run the timing harnesses sequentially. Compare the supplied hashes before comparing timings. Card, list, and computed-cart cases characterize the implementation so far; they do not replace Looma catalog qualification or establish overall performance for HTML Next components.

The computed-cart fixture multiplies half-integer prices by quantities of one or three, keeping its numeric text in the common serialization behavior of both engines. Fluid can retain a trailing `.0` for other multiplication inputs, so that fixture does not establish general number serialization equivalence. Early computed-cart timings were slower than Fluid despite lower allocations; the speed target remains unproven for expression-heavy rendering.

The [low-memory measurements](benchmarks/results/2026-11-05-low-memory.md) include two Fluid comparison runs and binding/output allocation attribution. The [initial experiment](benchmarks/results/2026-11-05-native-slice.md) retains the original baseline, Node adapter results, and platform probes.

## Ownership

Native source, tests, and benchmark dependencies live in this directory. Root CI selects a separate .NET job and never packs this project as an npm package. The existing JavaScript compiler owns `analyzeClientPlan` and emits the shared client plan through the native unplugin's build manifest. HTMLKit consumes that analysis for its browser graph; this .NET slice does not yet consume the artifact or emit hydration records. Both server implementations will use the same selected client assets and existing browser runtime.
