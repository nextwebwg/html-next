# HTML Next live component graph

This runnable, unbundled example uses the reference implementation's browser entry. It has one application document, component definitions in separate HTML files,
and component modules with named `connect` exports. There is no example-only runtime.

From the repository root:

```sh
npm run build
python3 -m http.server 8799
# open http://localhost:8799/examples/poc/
```

The page loads `dist/browser.js` from its `<head>` and selects one root with
`<link rel="component">` and an import-map prefix. The root definition declares its component
dependencies; each stateful definition names its module on the carrier. The browser entry
starts itself: it loads the inert definition graph, lowers the current instances, observes
later definitions and instances, lazily imports modules on connection, and cleans them up
on disconnect.

The example demonstrates the same live trust model as the specification: the application
owns the direct mapped root, relative definition edges stay within that root, fetched HTML
cannot add active policy, and module code runs as ordinary same-realm ESM under native
CORS and CSP rules.
