# Targets and conformance

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
