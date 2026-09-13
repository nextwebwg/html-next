# Targets and conformance

## Delivery modes

The [delivery-mode contract](delivery-modes.md) defines three conforming products over one
normalized component graph:

1. The [live browser distributable](live-browser-distributable.md) accepts application-selected component definitions and instances
   dynamically and supports the complete language without requiring a build.
2. The [native application/library build](native-application-build.md) follows concrete entries, computes the capabilities used by
   the complete graph, and emits native DOM modules with shared build-scoped support. Application
   output may be a complete UI runtime; library output keeps independently consumable entries whose
   shared imports can be combined by the consuming bundler.
3. [Framework conversion](framework-conversion.md) emits React, Vue, or Svelte components and maps HTML Next semantics onto the
   target framework's native reactivity, lifecycle, and rendering facilities.

Capability fixtures may measure one language feature in isolation, but they do not define a
per-component runtime architecture. Runtime sharing and pruning are properties of the resulting
application or library graph.

## Target equivalence

The browser runtime, Vanilla DOM, React, Vue, and Svelte targets consume one normalized semantic model. For the same inputs they must agree on the public native root, effective attributes and properties, projected content and identity, text/HTML output, events, public methods, validation, styles, lifecycle, component lineage, and hydration result.

Target-native reactivity and typing are encouraged; target-private language semantics are forbidden. A target adapter may provide a small runtime helper where its framework has no equivalent primitive.

## Package output

A package build starts from concrete HTML entries and follows component, controller, and static ESM edges without executing authored code. Its build inventory lists generated artifacts, preserved module/type/style exports, and direct and transitive dependencies. The inventory is build evidence, not component source.

Packages may expose side-effect custom-element registration, framework adapters, concrete HTML entries, types, CSS/themes, and ordinary JavaScript libraries. Ordinary library exports remain ordinary ESM; installing a package does not hide the component graph behind a package-name registration script.

## Migration

Migration tooling may extract Stencil public metadata, slot/style facts, and safely recoverable templates into HTML Next scaffolds. It must report source-located gaps for imperative behavior and create explicit reviewed controller work. It must never label guessed TypeScript behavior as converted.

The Looma baseline contains 34 public core components. Each must have a reviewed disposition, and each component included by Looma's public package contract must be behaviorally ported and tested before a Looma-compatible package is accepted. Consumer proof includes Knit-shaped Vue/Nuxt imports and LoadOps-shaped side-effect registration with direct `ui-*` authoring.

## Deferred features

Runtime-selected component types, arbitrary portals, optional Shadow DOM, streaming transports, routing, pagination accumulation, optimistic updates, and unspecified cache/auth policy are deferred. A deferred feature has no implied syntax or compatibility promise.

Rewriting Tiptap, Valibot, icon libraries, or other ordinary JavaScript dependencies into HTML is not a component-language requirement. Their explicit package edges remain testable.
