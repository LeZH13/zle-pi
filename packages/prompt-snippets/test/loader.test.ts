import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSnippetConfigFile, loadSnippets, parseSnippet, scanSnippetDirectory } from "../extensions/loader.js";

describe("prompt snippets loader", () => {
	let tempDir: string;
	let bundledDir: string;
	let globalDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-snippets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		bundledDir = join(tempDir, "bundled");
		globalDir = join(tempDir, "global");
		projectDir = join(tempDir, "project");

		mkdirSync(bundledDir, { recursive: true });
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	describe("parseSnippet", () => {
		it("parses valid frontmatter and body", () => {
			const raw = `---
name: Custom Rule
description: A helpful custom rule
placement: prepend
order: 10
---
Always verify edge cases.`;

			const result = parseSnippet("rule.md", raw, "bundled", "/path/to/rule.md");
			expect(result.disabled).toBe(false);
			expect(result.snippet).toEqual({
				id: "rule.md",
				name: "Custom Rule",
				description: "A helpful custom rule",
				placement: "prepend",
				order: 10,
				body: "Always verify edge cases.",
				source: "bundled",
				filePath: "/path/to/rule.md",
			});
		});

		it("falls back to default name, placement, and order", () => {
			const raw = `---
description: No name given
---
Default body text`;

			const result = parseSnippet("my-snippet.md", raw, "global", "/path/my-snippet.md");
			expect(result.disabled).toBe(false);
			expect(result.snippet?.name).toBe("my-snippet");
			expect(result.snippet?.placement).toBe("append");
			expect(result.snippet?.order).toBe(9999);
		});

		it("detects disabled: true in frontmatter", () => {
			const raw = `---
name: Disabled Rule
disabled: true
---
Body text`;

			const result = parseSnippet("disabled.md", raw, "project", "/path/disabled.md");
			expect(result.disabled).toBe(true);
			expect(result.snippet).toBeNull();
		});

		it("detects enabled: false in frontmatter", () => {
			const raw = `---
name: Disabled Rule
enabled: false
---
Body text`;

			const result = parseSnippet("disabled.md", raw, "global", "/path/disabled.md");
			expect(result.disabled).toBe(true);
			expect(result.snippet).toBeNull();
		});

		it("returns null for malformed frontmatter or empty body", () => {
			expect(parseSnippet("invalid.md", "no frontmatter", "bundled", "").snippet).toBeNull();
			expect(parseSnippet("empty.md", "---\nname: Empty\n---\n", "bundled", "").snippet).toBeNull();
		});
	});

	describe("loadSnippetConfigFile", () => {
		it("loads disabled list from prompt-snippets.json", () => {
			const configPath = join(tempDir, "prompt-snippets.json");
			writeFileSync(configPath, JSON.stringify({ disabled: ["ask-questions", "rule.md"] }));

			const config = loadSnippetConfigFile(configPath);
			expect(config?.disabled).toEqual(["ask-questions", "rule.md"]);
		});

		it("returns null when file does not exist", () => {
			expect(loadSnippetConfigFile(join(tempDir, "missing.json"))).toBeNull();
		});
	});

	describe("scanSnippetDirectory", () => {
		it("scans and categorizes active and disabled snippets", () => {
			writeFileSync(
				join(bundledDir, "active.md"),
				`---
name: Active
---
Active body`,
			);
			writeFileSync(
				join(bundledDir, "off.md"),
				`---
name: Off
disabled: true
---
Off body`,
			);

			const { snippets, disabledIds } = scanSnippetDirectory(bundledDir, "bundled");
			expect(snippets.length).toBe(1);
			expect(snippets[0].id).toBe("active.md");
			expect(disabledIds.has("off.md")).toBe(true);
		});
	});

	describe("loadSnippets hierarchy & precedence", () => {
		it("merges bundled, global, and project snippets with proper overrides", () => {
			// 1. Bundled snippet
			writeFileSync(
				join(bundledDir, "rule-a.md"),
				`---
name: Bundled Rule A
order: 20
placement: append
---
Bundled Rule A body`,
			);
			writeFileSync(
				join(bundledDir, "rule-b.md"),
				`---
name: Bundled Rule B
order: 10
placement: prepend
---
Bundled Rule B body`,
			);

			// 2. Global snippets (overrides rule-a, adds rule-c)
			const globalSnippetsDir = join(globalDir, "snippets");
			mkdirSync(globalSnippetsDir, { recursive: true });
			writeFileSync(
				join(globalSnippetsDir, "rule-a.md"),
				`---
name: Global Override Rule A
order: 5
placement: append
---
Global Rule A body`,
			);
			writeFileSync(
				join(globalSnippetsDir, "rule-c.md"),
				`---
name: Global Rule C
order: 50
placement: append
---
Global Rule C body`,
			);

			// 3. Project snippets (overrides rule-b)
			const projectSnippetsDir = join(projectDir, ".pi", "snippets");
			mkdirSync(projectSnippetsDir, { recursive: true });
			writeFileSync(
				join(projectSnippetsDir, "rule-b.md"),
				`---
name: Project Override Rule B
order: 1
placement: prepend
---
Project Rule B body`,
			);

			const loaded = loadSnippets({
				bundledDir,
				agentDir: globalDir,
				cwd: projectDir,
				isProjectTrusted: true,
			});

			expect(loaded.length).toBe(3);

			// Prepend group first: rule-b (project override)
			expect(loaded[0].id).toBe("rule-b.md");
			expect(loaded[0].name).toBe("Project Override Rule B");
			expect(loaded[0].source).toBe("project");

			// Append group next (sorted by order: rule-a order 5, rule-c order 50)
			expect(loaded[1].id).toBe("rule-a.md");
			expect(loaded[1].name).toBe("Global Override Rule A");
			expect(loaded[1].source).toBe("global");

			expect(loaded[2].id).toBe("rule-c.md");
			expect(loaded[2].name).toBe("Global Rule C");
			expect(loaded[2].source).toBe("global");
		});

		it("allows project snippet to disable a bundled snippet via frontmatter", () => {
			writeFileSync(
				join(bundledDir, "rule-a.md"),
				`---
name: Rule A
---
Rule A body`,
			);

			const projectSnippetsDir = join(projectDir, ".pi", "snippets");
			mkdirSync(projectSnippetsDir, { recursive: true });
			writeFileSync(
				join(projectSnippetsDir, "rule-a.md"),
				`---
disabled: true
---`,
			);

			const loaded = loadSnippets({
				bundledDir,
				agentDir: globalDir,
				cwd: projectDir,
				isProjectTrusted: true,
			});

			expect(loaded.find((s) => s.id === "rule-a.md")).toBeUndefined();
		});

		it("allows disabling snippets via prompt-snippets.json config file", () => {
			writeFileSync(
				join(bundledDir, "rule-a.md"),
				`---
name: Rule A
---
Rule A body`,
			);
			writeFileSync(
				join(bundledDir, "rule-b.md"),
				`---
name: Rule B
---
Rule B body`,
			);

			const projectConfigPath = join(projectDir, ".pi", "prompt-snippets.json");
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(projectConfigPath, JSON.stringify({ disabled: ["rule-a"] }));

			const loaded = loadSnippets({
				bundledDir,
				agentDir: globalDir,
				cwd: projectDir,
				isProjectTrusted: true,
			});

			expect(loaded.length).toBe(1);
			expect(loaded[0].id).toBe("rule-b.md");
		});

		it("ignores project snippets when project is untrusted", () => {
			const projectSnippetsDir = join(projectDir, ".pi", "snippets");
			mkdirSync(projectSnippetsDir, { recursive: true });
			writeFileSync(
				join(projectSnippetsDir, "untrusted-rule.md"),
				`---
name: Untrusted Rule
---
Untrusted body`,
			);

			const loaded = loadSnippets({
				bundledDir,
				agentDir: globalDir,
				cwd: projectDir,
				isProjectTrusted: false,
			});

			expect(loaded.find((s) => s.id === "untrusted-rule.md")).toBeUndefined();
		});
	});
});
