# Release mechanics

`@nextwebwg/html-next`, `@nextwebwg/html-next-converter`,
`@nextwebwg/html-next-unplugin`, and `@nextwebwg/htmlkit` share one version and publish together. A release changes all
four package manifests and the core `GENERATOR_VERSION` to the same unused version. Regenerate
the checked-in examples and snapshots after changing the generator version.

From the repository root, verify the candidate with a supported Node version and Corepack pnpm:

```sh
corepack pnpm verify:pr
corepack pnpm verify:release
```

`verify:pr` checks package metadata and the generated output. `verify:release` rejects version
skew, checks the generator version, and installs a packed package in an isolated consumer. The
consumer checks public JavaScript and declaration exports and bundles the browser entries.

Merging the reviewed version change to `main` runs [the release workflow](../../../.github/workflows/release.yml).
It attempts every package in the set through npm trusted publishing with provenance. A successful
run publishes each new version to `latest`. When rerun after a partial failure, it skips packages
whose version already exists and publishes the missing packages; it fails if any publish fails.
Confirm all four `latest` dist-tags after npm finishes processing the uploads.

A new package name needs a manual first publish and npm trusted-publisher setup before it can
join the workflow. An existing npm version cannot be replaced, so a correction uses a new shared
version for all four packages.
