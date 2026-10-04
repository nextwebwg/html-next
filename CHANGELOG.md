# Changelog

## Unreleased

## 1.0.0-alpha.25

### Fixed

- Generated Vue components type nonempty scalar `concat()` calls as text, allowing strict consumer checks for ARIA attributes, IDs, slots, and child-component props. Invalid calls retain their sentinel type and runtime behavior.

## 1.0.0-alpha.24

### Added

- Reactive inline text expressions with single braces, including `{$user.name}`, across native, Vue, React, and server rendering.
- Intl formatting expressions with explicit formatters or declared-type inference, native options, and an optional locale; Node 22 server rendering includes duration formatting.
- Reproducible reactive benchmarks, pinned development-only comparison libraries, and a required performance regression check against main.

### Improved

- Repeated Intl formatting reuses bounded native formatter instances across updates and generated component instances.
- Identifier names exclude dollars, dashes, and escapes; references stay case-sensitive, and public prop names cannot differ only by ASCII casing.

## 1.0.0-alpha.23

### Added

- Source-only Vue and React library imports through the Vite adapter, with on-demand conversion, generated consumer declarations, and standalone type-sync support.
- Multiple component definitions in one HTML resource, each exposed as a distinct named export while unused components remain tree-shakeable.
- React 19.3 conversion for application and recursively discovered library component graphs. Generated TSX, plain CSS, controllers, and feature-specific helpers run without the HTML Next runtime.
- Distributable library output with typed React exports and dependency metadata, alongside native HTML Next and Vue entries.

### Improved

- React parity for props, state, computed values, events, context, slots, declared data, native form controls, safe HTML, structural templates, controllers, SSR, and hydration.
- Shared Vue and React generated sanitizer and data-URL logic, while keeping framework-specific rendering and control behavior separate.
- Three-browser behavior and pixel checks for the shared conformance corpus and feature-specific converter fixtures, including an installed nested-library consumer.

React applications continue to use React's native `onRecoverableError` handling for incompatible hydration roots; the converter does not replace that flow with an `HR005` wrapper.
