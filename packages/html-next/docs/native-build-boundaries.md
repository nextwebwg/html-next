# Checked implementation boundaries

A native build host can supply `isImplementationBoundary(definition, id)` to
`loadNodeComponents` or `buildComponentGraph`. It validates the exact canonical
definition identity, expected interface revision and target implementation, then
returns `true` only when that implementation replaces the definition’s browser
implementation. The compiler does not choose or qualify a native presenter.

Source parsing, final URL trust-root checks and duplicate definition diagnostics
still run. A selected boundary keeps its original source contract and is marked
`implementationBoundary` in the graph. Its web styles, controller/module and
component dependency edges are not loaded. Browser-only whole-graph style checks
exclude that replaced implementation. If a resource contains an unbound sibling,
its shared dependency declarations still load for that sibling, and the sibling’s
styles and controller retain their normal behavior.

The Node loader forwards the same callback; omission preserves normal browser
build behavior. A host rejects missing, stale or wrong-target bindings itself.
Silently treating a missing qualification result as a browser implementation does
not establish a valid native manifest. This is a build-tool API, not a protocol
change or a native renderer for arbitrary HTML/CSS.

Focused graph tests cover boundary replacement and mixed-resource siblings. A
Node-loader test checks forwarding with a final canonical URL and refuses any
browser dependency, stylesheet or controller access. Consumer native manifest and
project-generation checks remain separate qualification of the host and presenter.
