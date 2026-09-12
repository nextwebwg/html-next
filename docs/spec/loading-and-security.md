# Loading and security

## Dependency graph

Definitions declare their dependencies; applications decide what roots to load and how specifiers resolve. A document or definition may use `link[rel=component]` for component HTML. A definition may name one controller module on its `template[component]` carrier. Controller modules use ordinary static ESM imports.

The resolver canonicalizes and deduplicates component URLs, detects tag collisions and cycles, and builds an inspectable graph without executing controllers. An already registered custom element takes precedence over HTML Next lowering for the same tag.

```html conforming
<link rel="component" href="./legend.html">
<template component="x-chart" controller="./chart.js">
  <figure><slot></slot><x-legend></x-legend></figure>
</template>
```

Installed-package builds walk the same concrete HTML, controller, and static ESM edges ahead of time. They do not require a browser import map or an author-written registration manifest.

## Controller module protocol

The `controller` attribute binds its owning component definition to one ES module. That module's default export must be a function accepting the component host. The component tag is already known from the owning `template[component]`; a controller module does not repeat it and does not call a registration API.

```js conforming
// chart.js
export default function controller(host) {
  host.effect(() => renderChart(host.refs.canvas, host.state.series));
}
```

A native implementation resolves and imports the declared module, verifies that its default export is callable, and invokes it once for each connected instance. A polyfill performs the same steps. The author-facing module therefore has no dependency on the polyfill and remains the same source when the feature is implemented by browsers. A missing or non-callable default export reports a stable controller-module diagnostic and leaves the declarative component output intact and uncontrolled.

Importing a controller module is idempotent under normal ESM semantics, while invoking its default export is per instance. Ahead-of-time targets may replace the dynamic load with a static default import and pass that function to their target-specific host adapter without changing the controller source.

## Live trust policy

Live cross-origin use is an application opt-in. The top-level application maps a bare prefix to a versioned HTTPS root using an ordinary import map and directly links a concrete component entry. Component HTML dependencies must resolve within that mapped prefix after URL normalization and final-response redirects.

A declared controller entry must initially resolve within the same approved prefix. After native `import()` begins, redirects and transitive ESM imports are governed by the browser module loader, CORS, and CSP: the platform provides no pre-execution final-response hook to the polyfill. This is not weaker than trusting bytes served at the already approved controller URL, and the specification does not claim an unenforceable second module sandbox.

Imported definitions cannot install or alter import maps, base URLs, CSP, trust roots, or application policy. A dependency that intentionally moves to another package/origin uses another application-owned mapping and direct root decision.

## Controller authority

A loaded controller is ordinary same-realm application code. ESM gives it deterministic resolution, caching, and a statically inspectable dependency graph; ESM does not restrict DOM or network authority. CSP and CORS continue to apply.

The security improvement over imported HTML documents is narrower and concrete: component HTML is inert data with a constrained grammar, and only the explicitly declared controller edge enters the native module graph. There is no imported document that discovers and executes arbitrary script elements or mutates loading policy.

Applications that need containment must use a Worker for non-DOM computation or a sandboxed cross-origin iframe for DOM-capable untrusted code. HTML Next does not rename trust as a sandbox.

## Inert definitions

Fetched component HTML is parsed into an inert document before registration. It must reject script elements, import maps, base elements, policy-changing metadata, inline event attributes, executable framework directives, unsafe dynamic sinks, and malformed parser-recovery shapes.

Sanitized `$html` or CMS content is never scanned for component definitions. Safe HTML insertion and component registration are separate pipelines. Sanitization removes active markup and dangerous contextual values; Trusted Types may protect sinks but does not make malicious script trustworthy.
