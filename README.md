# zle-pi

Personal development workspace for building organized, independently installable [Pi](https://pi.dev) extensions, skills, prompt templates, and themes.

This repository is intended to be an npm-workspace monorepo: each directory under `packages/` can be a focused Pi package with its own manifest, dependencies, tests, and documentation.

## Repository status

The repository currently contains its development conventions and handbook. Workspace configuration and Pi packages can be added incrementally as the first resources are built.

## Planned layout

```text
zle-pi/
├── AGENTS.md
├── README.md
├── package.json                 # npm workspaces and repository-wide scripts
├── packages/
│   └── <package-name>/
│       ├── package.json         # Pi manifest and package dependencies
│       ├── README.md
│       ├── extensions/
│       │   ├── simple.ts
│       │   └── complex/
│       │       ├── index.ts
│       │       └── helpers.ts
│       ├── skills/
│       │   └── <skill-name>/
│       │       ├── SKILL.md
│       │       ├── references/
│       │       ├── scripts/
│       │       └── assets/
│       ├── prompts/
│       ├── themes/
│       └── test/
└── shared/                      # proven cross-package fixtures/utilities
```

A package may expose a single resource or a cohesive bundle. Package-only implementation stays in that package; shared code is extracted only when multiple packages need the same maintained contract.

## Prerequisites

- Node.js and npm
- Pi installed and available as `pi`
- A trusted checkout when loading project-local Pi resources

Install Pi using the current instructions in the [official README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

## Bootstrap

Once the root workspace manifest exists:

```bash
npm install
npm test
npm run typecheck
```

Treat the scripts in the current `package.json` as authoritative; the commands above are the intended baseline, not a substitute for inspecting the manifest.

## Creating a package

1. Create `packages/<package-name>/package.json`.
2. Add only the resource directories the package owns.
3. Expose them with explicit `pi` manifest entries.
4. Add the package's runtime dependencies, tests, and README.
5. Load the local package in Pi and exercise each exposed resource.

A typical package manifest is shaped like this:

```json
{
  "name": "@zle-pi/example",
  "version": "0.0.0",
  "private": true,
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions/*.ts", "./extensions/*/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Adjust the manifest to expose exactly what the package contains. Keep `"private": true` for workspace-only packages; remove it before publishing a package to npm. Third-party runtime libraries belong in `dependencies`. Pi-provided core packages remain peer dependencies and are not bundled.

If a distributed package re-exports resources from another Pi package, add that package to both `dependencies` and `bundledDependencies`, then reference its resources with explicit `node_modules/<package>/...` paths in the `pi` manifest. Pi packages have isolated module roots, so a separate installation is not a substitute for bundling the dependency.

## Development loop

### Test a package temporarily

```bash
pi -e ./packages/<package-name>
```

This is useful for a quick run without installing the package. Restart the run after source changes.

### Install a package into project settings

```bash
pi install -l ./packages/<package-name>
pi
```

After the project is trusted, project-local packages load from `.pi/settings.json`. Use `/reload` while iterating on auto-discovered project resources; restart Pi when a lifecycle or loading change needs a clean startup test.

### Test one resource directly

```bash
pi -e ./packages/<package-name>/extensions/<extension>.ts
pi --skill ./packages/<package-name>/skills/<skill>/SKILL.md
pi --prompt-template ./packages/<package-name>/prompts/<template>.md
pi --theme ./packages/<package-name>/themes/<theme>.json --use-theme <theme-name>
```

For `--use-theme`, `<theme-name>` is the `"name"` declared inside the theme JSON, which may differ from its filename.

### Verify changes

Use the scripts declared by the owning package and root workspace. The expected sequence is:

1. Run the narrowest relevant Vitest test.
2. Run the owning package's tests and typecheck.
3. Run repository-wide tests and typecheck.
4. Load the package in Pi and verify discovery plus user-visible behavior.
5. Before release, inspect the package tarball and confirm every `pi` manifest path is included.

## Resource notes

### Extensions

Pi loads TypeScript directly, so a compile step is not required for ordinary extension loading. Extensions can register tools, commands, event handlers, providers, and custom TUI components. Keep default views compact, make blocking work cancellable, truncate large tool output, and clean up session resources on shutdown.

### Skills

Each skill lives in its own directory with a `SKILL.md`. Its frontmatter needs a valid lowercase hyphenated `name` and a specific `description`; that description determines when Pi offers the skill to the model. Put branch-specific detail in linked references so the main workflow remains legible.

### Prompt templates

Prompt filenames become slash commands. Templates support optional `description` and `argument-hint` frontmatter plus positional/default argument expansion. Prompt discovery is non-recursive unless deeper files are explicitly exposed.

### Themes

Themes are JSON files with a unique name and the official theme schema. Test all message, markdown, tool, selection, and thinking-level states—not only the primary palette.

## Official references

Use the installed documentation matching the active Pi version when developing. Online references:

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Extension examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Prompt templates](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md)
- [Themes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [TUI API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)

## Working agreements

Repository-specific agent instructions live in [`AGENTS.md`](./AGENTS.md). Package-specific behavior belongs in the owning package's README rather than being duplicated at the repository root.

## License

No license has been selected yet.
