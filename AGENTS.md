# Repository instructions

## Purpose

Develop independently installable Pi packages—extensions, skills, prompt templates, and themes—in an npm-workspace monorepo. Keep packages focused and co-locate their tests, helpers, and documentation; extract shared code only after two packages need the same maintained contract.

## Source of truth

Pi APIs and resource formats change. Resolve the installed docs root with `$(npm root -g)/@earendil-works/pi-coding-agent`, then read the branch that matches the work:

- **Extensions/tools** — changing factories, events, commands, tools, providers, lifecycle, or rendering: `docs/extensions.md` and `examples/extensions/`
- **TUI** — building components, editors, widgets, overlays, or key handling: `docs/tui.md`
- **Skills** — changing discovery, frontmatter, invocation, or skill layout: `docs/skills.md`
- **Prompts** — changing template discovery, arguments, or frontmatter: `docs/prompt-templates.md`
- **Themes** — changing theme format, tokens, or loading: `docs/themes.md`
- **Packages** — changing manifests, dependencies, installation, filtering, or distribution: `docs/packages.md`

Follow cross-references needed by the feature. Treat package manifests, TypeScript configuration, and npm scripts as the repository source of truth rather than restating them in documentation.

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
    test/                # package-level integration tests
shared/                  # cross-package test fixtures or non-package utilities
```

A package may contain one resource or a cohesive bundle. Its `package.json` must expose exactly the intended resources through the `pi` manifest; prefer explicit paths or narrow globs over accidental discovery. Keep internal modules outside exposed resource paths.

## Workflow

1. **Locate the owner.** Identify the affected workspace package and inspect its `package.json`, tests, and local README. Completion: every changed file has one clear package owner, or the change is explicitly repository-wide.
2. **Check the contract.** Read the relevant official Pi documentation before using or changing Pi APIs, schemas, lifecycle behavior, discovery, or manifests. Completion: the implementation matches the current installed API rather than remembered syntax.
3. **Make the narrow change.** Preserve package boundaries and co-locate package-only helpers. Add or update tests for observable behavior. Completion: no unrelated package or shared abstraction changed without a demonstrated need.
4. **Verify.** Run the narrowest relevant Vitest test first, then `npm test --workspace <package-name>` and the package/root checks declared by npm scripts. Exercise resource discovery or runtime behavior when static tests cannot prove it. Completion: all applicable checks pass; any unavailable check is named with the reason.
5. **Document the surface.** Update the owning package README when installation, commands, tools, configuration, invocation, or user-visible behavior changes. Completion: a user can discover and use the changed surface without reading its implementation.
6. **Publish and catalog.** Bump the package version based on scope (+0.0.1 for small fixes/tweaks, +0.1.0 for larger features, 1.0.0 / +1.0.0 for major refactors or breaking changes), tag `keywords` with `"pi-package"` in `package.json` for pi.dev/packages discovery, add optional `pi.image`/`pi.video` preview media, and publish publicly (`--access public` for scoped). Completion: the package version reflects change scope, carries the `"pi-package"` keyword, and is publicly released for catalog indexing.

## Resource contracts

### Extensions

- Export a default extension factory and use types from `@earendil-works/pi-coding-agent`.
- Put Pi-provided core packages (`@earendil-works/pi-*` and `typebox`) in `peerDependencies` with `"*"`; put third-party runtime libraries in the owning package's `dependencies`.
- Use TypeBox schemas and `StringEnum` from `@earendil-works/pi-ai` for string enums accepted by tools.
- Throw from tool execution to report failure. Return compact LLM-facing `content` and structured renderer/state data in `details`.
- Bound tool output using Pi's truncation utilities and disclose truncation plus the full-output location.
- Pass cancellation signals to blocking work. Start long-lived resources at `session_start` or on demand, and release them idempotently at `session_shutdown`.
- Guard terminal-only behavior with `ctx.mode === "tui"` and dialog/notification behavior with `ctx.hasUI`.
- Wrap complete read-modify-write windows with `withFileMutationQueue()` when a custom tool mutates files.

Completion: types and tests pass, the extension loads in Pi, registered surfaces behave in every supported mode, and shutdown leaves no process, watcher, socket, or timer behind.

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

- Include the official schema URL, a unique slash-free name, and the complete required color-token set.
- Test representative messages, markdown, tool states, selection states, wrapping, and intended terminal backgrounds.

Completion: the theme loads without validation errors and remains legible across the tested states.

## Package boundary

Each installable workspace package owns its manifest, runtime dependencies, tests, and user documentation. When one distributed Pi package exposes resources from another Pi package, list that dependency in both `dependencies` and `bundledDependencies`, then expose its resources through explicit `node_modules/<package>/...` manifest paths. Verify the packed artifact before release so every manifest path and required runtime file is present. A package is complete only when it can be loaded from its package directory without relying on undeclared repository state.
