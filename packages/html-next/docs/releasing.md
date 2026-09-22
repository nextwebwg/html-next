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

## Trusted publishing

Merging to `main` publishes: `.github/workflows/release.yml` publishes each listed package whose
version is not yet on npm, on the `next` dist-tag, through npm trusted publishing (OIDC, with
automatic provenance). Release by bumping a package's version in a pull request.

A new package's first version is published manually, because npm configures a trusted publisher
only for an existing package. Then, on npmjs.com, add this repository and `release.yml` as the
package's trusted publisher, and add the package to the workflow's list.
