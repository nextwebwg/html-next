# Full-stack HTML Next with Node

Requires Node 24. Copy this directory to an application folder, then run:

```sh
npm install
npm run build
npm start
```

Open `http://localhost:5001/?start=12`. The initial server HTML contains `Count: 12`. The generated JavaScript hydrates the button and its module handles clicks, so the next value is `Count: 13`. Disable JavaScript and reload to see the initial value independently.

The template declares `doubled` as `$count * 2`: the initial output is `Double: 24`, then `Double: 26` after the click. The module writes only `count`; the declared dependency updates the derived output.

The server uses `@nextwebwg/html-next/server`; Vite builds matching client factories and the hydration entry. The HTTP example serves only files loaded from the generated assets directory.

This example uses the same `counter.html`, `counter.js`, `main.js` and Vite configuration as the [C# example](../../../html-next-dotnet/examples/counter). Both hosts evaluate the declared prop and state seed before JavaScript takes over browser interaction.

Rebuild after changing the component or its module, and deploy the source and built assets together. The [full-stack guide](https://nextwebwg.org/html-next/full-stack) covers both hosts and their rendering boundaries.
