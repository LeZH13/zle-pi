# Repository instructions

## Purpose

Develop independently installable Pi packages—extensions, skills, prompt templates, and themes—in an npm-workspace monorepo. Keep packages focused and co-locate their tests, helpers, and documentation; extract shared code only after two packages need the same maintained contract.

Scope changes to the requested work. Remove obsolete paths within that scope; ask before removing supported behavior or changing public contracts the user did not request.

## Source of truth

When work depends on Pi APIs or resource formats, read the documentation and relevant example for the version being targeted. For repository changes, start with `node_modules/@earendil-works/pi-coding-agent`; for host-specific debugging, use the active Pi installation. Check that the path exists and confirm its package version. Use `$(npm root -g)/@earendil-works/pi-coding-agent` only when Pi is actually installed there. If the target docs are unavailable, report that limitation rather than silently substituting another version.

Choose the branch that matches the work:

- **Extensions/tools** — changing factories, events, commands, tools, providers, lifecycle, or rendering: `docs/extensions.md` and `examples/extensions/`
- **TUI** — building components, editors, widgets, overlays, or key handling: `docs/tui.md`
- **Skills** — changing discovery, frontmatter, invocation, or skill layout: `docs/skills.md`
- **Prompts** — changing template discovery, arguments, or frontmatter: `docs/prompt-templates.md`
- **Themes** — changing theme format, tokens, or loading: `docs/themes.md`
- **Packages** — changing manifests, dependencies, installation, filtering, or distribution: `docs/packages.md`

Follow cross-references needed by the feature; reuse documentation already verified for the same version and contract. Pure application-logic or prose edits do not require a fresh API lookup. Treat package manifests, TypeScript configuration, and npm scripts as the repository source of truth rather than duplicating them here.

## Structure

Use this shape unless an existing package establishes a stronger local convention:

```text
packages/
  <package-name>/
    package.json
    extensions/          # .ts files or <extension>/index.ts
    skills/              # <skill>/SKILL.md plus local references/assets
    prompts/             # non-recursive .md templates
    themes/              # .json themes
    test/                # package-owned unit and integration tests
shared/                  # cross-package test fixtures or non-package utilities
```

A package may contain one resource or a cohesive bundle. Its `package.json` must expose exactly the intended resources through the `pi` manifest; prefer explicit paths or narrow globs over accidental discovery. Keep internal modules outside exposed resource paths.

## Workflow

1. **Locate the owner.** Inspect the working tree and preserve unrelated changes. Identify the affected workspace package and inspect its `package.json`, tests, and local README. Completion: every changed file has one clear package owner, or the change is explicitly repository-wide.
2. **Check the contract.** Read the relevant official Pi documentation before using or changing Pi APIs, schemas, lifecycle behavior, discovery, or manifests. Completion: the implementation matches the current installed API rather than remembered syntax.
3. **Make the narrow change.** Preserve package boundaries and co-locate package-only helpers. Add or update tests for observable behavior. Completion: no unrelated package or shared abstraction changed without a demonstrated need.
4. **Verify the affected surface.** For code changes, run the narrowest relevant test first, then the owning package's test and typecheck scripts. Run root checks when shared code, repository configuration, dependencies, or cross-package behavior changes. Run each distinct check once, accounting for package scripts that already check the root configuration. For resources and manifests, validate discovery and packaging; for prose-only edits, check references and consistency rather than rerunning unrelated suites. Completion: applicable checks pass; unavailable checks, pre-existing failures, and untested runtime behavior are named with reasons.
5. **Document the surface.** Update the owning package README when installation, commands, tools, configuration, invocation, or user-visible behavior changes. Completion: a user can discover and use the changed surface without reading its implementation.
6. **Version deliberately.** Apply the versioning policy below when installable behavior changes. Completion: the intended unreleased version and lockfile agree, and user-visible breaking changes are documented. Development work is complete without a public release.

## Versioning and release

- Follow the user's requested version and release scope. By default, keep implementation work local; an implementation request is not permission to publish or create release tags.
- For pre-1.0 packages, use a patch bump (+0.0.1) for small fixes/tweaks and a minor bump (+0.1.0) for substantial features or redesigns. A small breaking tweak does not automatically require a minor bump or `1.0.0`; document the incompatibility explicitly.
- `1.0.0` is an intentional stable-contract milestone. Ask before crossing from `0.x` to `1.0.0`, or making a later major-version bump. For stable packages, propose patch/minor/major according to fix/additive-feature/breaking-contract scope; internal refactors alone are not breaking contracts.
- Bump once per intended release, not once per edit or follow-up in the same unreleased change set. Inspect the working tree before changing an existing bump. Prose-only and test-only changes do not require a package bump unless part of release preparation.
- Publishing is a separate, explicitly authorized task. Before publishing, confirm the package, version, and included changes; verify the packed artifact and required checks. For catalog releases, include `"pi-package"` in `keywords` and publish publicly (`--access public` for scoped packages). Preview media is optional.

## Resource contracts

### Extensions

- Export a default extension factory and use types from `@earendil-works/pi-coding-agent`.
- Put host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) in `peerDependencies` with `"*"`, without bundling them. Put third-party runtime libraries in the owning package's `dependencies`.
- Use TypeBox schemas and `StringEnum` from `@earendil-works/pi-ai` for string enums accepted by tools.
- Throw for ordinary execution failures; use the target SDK's `isError` result contract when a failure must retain structured output. Keep LLM-facing `content` compact, renderer/state data in `details`, and declared programmatic output in `structuredContent`.
- Bound potentially large tool output using Pi's truncation utilities. Disclose truncation and, when the full output is retained, its location; do not claim a full-output file exists unless it was written.
- Pass cancellation signals to blocking work. Start long-lived resources at `session_start` or on demand, and release them idempotently at `session_shutdown`.
- Guard terminal-only behavior with `ctx.mode === "tui"` and dialog/notification behavior with `ctx.hasUI`.
- Wrap complete read-modify-write windows with `withFileMutationQueue()` when a custom tool mutates files.

Completion for runtime changes: types and tests pass, the extension loads in Pi, affected surfaces behave in their supported modes, and shutdown releases owned resources. Report any runtime or mode checks that could not be exercised.

### Skills

- Give each skill a directory containing `SKILL.md` with valid `name` and specific `description` frontmatter.
- Write the description as the invocation pointer: name every distinct task branch that should load the skill.
- Keep the common workflow in `SKILL.md`; disclose branch-only reference, scripts, and assets through relative links.
- Use `disable-model-invocation: true` only for intentionally manual `/skill:<name>` workflows.

Completion: the name is at most 64 characters and matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; the description names each automatic invocation branch or `disable-model-invocation: true` makes it manual; every relative link resolves; helper scripts run from the documented working directory; and the intended invocation path works.

### Prompt templates

- Keep package templates directly under the exposed prompt directory unless the manifest explicitly lists deeper paths.
- Use frontmatter `description` and `argument-hint` when they improve slash-command discovery; keep positional arguments consistent with the hint.

Completion: Pi discovers the template, invocation expands all supported argument forms correctly, and the expanded prompt is usable without hidden context.

### Themes

- Include the official schema URL, a unique slash-free name other than reserved `system`, and the schema's required color-token set.
- Test representative messages, markdown, tool states, selection states, wrapping, and intended terminal backgrounds.

Completion: the theme loads without validation errors and remains legible across the tested states.

## Package boundary

Each installable workspace package owns its manifest, runtime dependencies, tests, and user documentation. When one distributed Pi package exposes resources from another Pi package, list that dependency in both `dependencies` and `bundledDependencies`, then expose its resources through explicit `node_modules/<package>/...` manifest paths. Verify the packed artifact before release so every manifest path and required runtime file is present. A package is complete only when it can be loaded from its package directory without relying on undeclared repository state.
