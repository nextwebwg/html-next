# Changelog

## Unreleased

### Added

- React 19.3 conversion for application and recursively discovered library component graphs. Generated TSX, plain CSS, controllers, and feature-specific helpers run without the HTML Next runtime.
- Distributable library output with typed React exports and dependency metadata, alongside native HTML Next and Vue entries.

### Improved

- React parity for props, state, computed values, events, context, slots, declared data, native form controls, safe HTML, structural templates, controllers, SSR, and hydration.
- Shared Vue and React generated sanitizer and data-URL logic, while keeping framework-specific rendering and control behavior separate.
- Three-browser behavior and pixel checks for the shared conformance corpus and feature-specific converter fixtures, including an installed nested-library consumer.

React applications continue to use React's native `onRecoverableError` handling for incompatible hydration roots; the converter does not replace that flow with an `HR005` wrapper.
