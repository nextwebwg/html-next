# Repository guidance

## Authority

- Treat README.md and checked-in project documentation as product authority.
- Treat threadlabs.config.json as the repository-standard manifest.
- Ask the owner when requirements conflict or a destructive operation is required.

## Workspace structure

- Keep proposal implementations in independently versioned packages under `packages/`.
- Put shared tooling at the repository root; keep proposal-specific source, tests, and build configuration with its package.
- Use pnpm through Corepack and preserve strict ESM TypeScript package boundaries.

## Safe work

- Preserve unrelated changes and never rewrite shared Git history without explicit approval.
- Preview Foundation plans before applying them.
- Check threadlabs.config.json for each path's ownership mode before editing. For managed paths, use .threadlabs.lock.json to confirm the last-applied content and change the owning Foundation template; preserve local paths and stop on ambiguous ownership.
- Use Oxlint for JavaScript and TypeScript linting. Do not add Prettier or another repository-wide formatter.
- Do not add Tailwind. Use project-owned CSS, CSS Modules, or an explicitly selected non-Tailwind styling approach.

## Verification

- During development, run the smallest focused test plus `pnpm verify:inner`.
- Before handoff, run `pnpm verify:pr` and report commands, results, skips, and remaining judgment.
- Packages remain private until the repository owner explicitly selects a license, public visibility, and a protected release workflow.
