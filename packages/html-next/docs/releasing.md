# Release mechanics

`@nextwebwg/html-next` is mechanically prepared for the manual
`1.0.0-alpha.0` package candidate. It remains deliberately unpublished and private until the
repository owner resolves the policy gate below.

## Verify the candidate

Use supported Node 24 with Corepack-provided pnpm from the repository root:

```sh
corepack pnpm verify:release
corepack pnpm release:dry-run
```

`verify:release` checks that the package and generator versions agree, then creates and installs a
real package tarball in an isolated consumer. The consumer checks every public export's JavaScript
and declaration target, imports the Node-safe entries, type-checks all entries, and bundles the
browser entries. Packing invokes `prepack`, which always performs a clean package build first.

`release:dry-run` runs npm's JSON dry-run pack report. Review its package name, version, filename,
file list, unpacked size, and integrity before publishing. The prerelease is configured for the
`next` dist-tag so it cannot become `latest` accidentally.

## Final policy gate

Do not publish while any of these conditions remains unresolved:

- the repository is not publicly visible;
- `packages/html-next/package.json` still contains `"private": true`; or
- npm ownership and the manual publisher's required authentication are not confirmed.

Once the owner has made those decisions, keep their implementation isolated to the visibility and
publication policy change. Re-run both commands above, remove the package's `private` safeguard in
that policy change, then create and publish the reviewed archive explicitly:

```sh
mkdir -p .release
corepack pnpm --filter @nextwebwg/html-next pack --pack-destination .release
npm publish .release/nextwebwg-html-next-1.0.0-alpha.1.tgz
```

## Later: trusted publishing with OIDC

The first alpha remains a manual publication. After it succeeds, replace long-lived npm tokens
with npm trusted publishing from GitHub Actions:

1. Configure the package's trusted publisher on npm with this repository, its owner, and the exact
   release workflow filename. Use a GitHub-hosted runner.
2. Pin the workflow to supported Node 24 and npm 11.5.1 or newer.
3. Grant only `contents: read` and `id-token: write`; do not configure `NODE_AUTH_TOKEN` for the
   publish job.
4. Put publishing behind a protected GitHub environment with required approval. Before
   `npm publish`, require a matching version tag, a clean checkout, the release verification, and
   review of the packed archive.

For a public npm package published from a public repository, npm trusted publishing automatically
generates package provenance. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) and GitHub's
[OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
