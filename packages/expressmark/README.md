# expressmark

JavaScript tooling for [Expressive Markdown](https://nextwebwg.org/expressive-markdown/),
a common language for documentation.

**Version 0.0.1 reserves the package name and establishes the ESM/TypeScript package.
It exports no API. Parsing, writing, rendering, and AST utilities are not implemented.**

The specification and official AST reference live in the
[public proposal](https://nextwebwg.org/expressive-markdown/ast), maintained in
[nextwebwg/specs](https://github.com/nextwebwg/specs/tree/main/expressive-markdown).
Future Markdown ↔ AST conversion will use parseman; this reservation has no runtime dependencies.

## Development

From the monorepo root, run `corepack pnpm --filter expressmark verify` to typecheck,
build, pack, and test the package from an installed consumer. Versions are independent of
the four lockstep HTML Next packages.

## Publishing

The first publication requires an npm maintainer to run `npm publish` on the verified
tarball; npm trusted publishing cannot create a package. Configure npm's trusted publisher
for repository `nextwebwg/html-next`, workflow `expressmark-release.yml`, and environment
`expressmark-release` after that first publication.

Later releases use the manual **Release expressmark** GitHub workflow on `main`. Its
`version` input must match `packages/expressmark/package.json`. The job verifies the package
before packing and publishes through OIDC with provenance. It uses the protected
`expressmark-release` environment; the repository owner must approve each publication.
It never publishes the component packages.

MIT licensed. See [LICENSE](./LICENSE).
