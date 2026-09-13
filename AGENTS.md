# Repository guidance

## Authority

- Treat README.md and checked-in project documentation as product authority.
- Treat threadlabs.config.json as the repository-standard manifest.
- Ask the owner when requirements conflict or a destructive operation is required.

## Workspace structure

- Keep proposal implementations in independently versioned packages under `packages/`.
- Put shared tooling at the repository root; keep proposal-specific source, tests, and build configuration with its package.
- Use pnpm through Corepack and preserve strict ESM TypeScript package boundaries.

## Browser runtime design

- Start every runtime design with an audit of native DOM and Web Platform behavior. Prefer composing existing browser parsing, observation, events, scheduling, cancellation, validation, and lifecycle primitives over implementing parallel machinery.
- Before adding custom browser-runtime behavior, record the relevant native mechanisms and the precise remaining gap. Proceed with the smallest proven layer when the answer is clear; consult the owner when the gap or semantic choice remains uncertain.
- For validation, first probe detached native controls configured with the proposed type and constraints. Treat their parsed values and `ValidityState` as authoritative wherever the platform defines the behavior.
- Keep the live parser/interpreter separate from generated component output. Generated components import only the helpers required by their authored features.

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
