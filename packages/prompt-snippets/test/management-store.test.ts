import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSnippets, parseSnippet } from "../extensions/loader.js";
import {
	deleteSnippet,
	hideSnippet,
	readSnapshot,
	saveSnippet,
	snippetDirectory,
} from "../extensions/management-store.js";
import type { LoadSnippetsOptions } from "../extensions/types.js";
import type { SnippetDraft, WritableScope } from "../extensions/management-store.js";

function draft(overrides: Partial<SnippetDraft> = {}): SnippetDraft {
	return {
		id: "test-rule.md",
		name: "Test Rule",
		description: "A test rule",
		placement: "append",
		order: 10,
		body: "Always test the happy path.",
		...overrides,
	};
}

describe("prompt snippets management store", () => {
	let tempDir: string;
	let bundledDir: string;
	let agentDir: string;
	let projectDir: string;
	let globalSnippetsDir: string;
	let projectSnippetsDir: string;
	let options: LoadSnippetsOptions;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-snippets-store-"));
		bundledDir = join(tempDir, "bundled");
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		globalSnippetsDir = join(agentDir, "snippets");
		projectSnippetsDir = join(projectDir, ".pi", "snippets");
		mkdirSync(bundledDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		options = { bundledDir, agentDir, cwd: projectDir, isProjectTrusted: true };
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("snippetDirectory", () => {
		it("resolves the global snippets dir under the agent dir", () => {
			expect(snippetDirectory(options, "global")).toBe(join(agentDir, "snippets"));
		});

		it("resolves the project snippets dir under .pi in the cwd", () => {
			expect(snippetDirectory(options, "project")).toBe(join(projectDir, ".pi", "snippets"));
		});

		it("rejects project scope without a cwd", () => {
			expect(() => snippetDirectory({ agentDir }, "project")).toThrow(/working directory/i);
		});

		it("rejects project scope when the project is not trusted", () => {
			expect(() => snippetDirectory({ ...options, isProjectTrusted: false }, "project")).toThrow(/trusted/i);
		});

		it("rejects unknown scopes at runtime", () => {
			expect(() => snippetDirectory(options, "bundled" as unknown as WritableScope)).toThrow(/scope/i);
		});
	});

	describe("readSnapshot", () => {
		it("returns null for missing files, even with a missing parent directory", () => {
			expect(readSnapshot(join(globalSnippetsDir, "missing.md"))).toBeNull();
		});

		it("returns the exact raw content", () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			writeFileSync(join(globalSnippetsDir, "a.md"), "---\nname: A\n---\nBody");
			expect(readSnapshot(join(globalSnippetsDir, "a.md"))).toBe("---\nname: A\n---\nBody");
		});

		it("refuses to read symlink files", () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			const real = join(tempDir, "real.md");
			writeFileSync(real, "real content");
			symlinkSync(real, join(globalSnippetsDir, "link.md"));
			expect(() => readSnapshot(join(globalSnippetsDir, "link.md"))).toThrow(/symlink/i);
		});

		it("throws for directories instead of pretending they are empty", () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			expect(() => readSnapshot(globalSnippetsDir)).toThrow();
		});
	});

	describe("saveSnippet", () => {
		it("creates a snippet and exposes it through the loader", async () => {
			await saveSnippet(options, "global", draft(), null);

			const raw = readSnapshot(join(globalSnippetsDir, "test-rule.md"));
			expect(raw).toBe(
				"---\nname: Test Rule\ndescription: A test rule\nplacement: append\norder: 10\n---\nAlways test the happy path.\n",
			);

			const loaded = loadSnippets(options);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toMatchObject({
				id: "test-rule.md",
				name: "Test Rule",
				description: "A test rule",
				placement: "append",
				order: 10,
				body: "Always test the happy path.",
				source: "global",
			});
		});

		it("creates nested project directories on demand", async () => {
			await saveSnippet(options, "project", draft(), null);

			expect(existsSync(join(projectSnippetsDir, "test-rule.md"))).toBe(true);
			const loaded = loadSnippets(options);
			expect(loaded[0]).toMatchObject({ id: "test-rule.md", source: "project" });
		});

		it("refuses to overwrite when expected is null (create only)", async () => {
			await saveSnippet(options, "global", draft(), null);
			await expect(saveSnippet(options, "global", draft({ body: "Replacement" }), null)).rejects.toThrow(
				/already exists/i,
			);
			expect(loadSnippets(options)[0]?.body).toBe("Always test the happy path.");
		});

		it("edits when the exact prior raw content matches", async () => {
			await saveSnippet(options, "global", draft(), null);
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			await saveSnippet(options, "global", draft({ body: "Updated body", order: 20 }), prior);

			const loaded = loadSnippets(options);
			expect(loaded[0]).toMatchObject({ body: "Updated body", order: 20 });
		});

		it("rejects stale expected content and leaves the file unchanged", async () => {
			await saveSnippet(options, "global", draft(), null);
			const stale = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			writeFileSync(join(globalSnippetsDir, "test-rule.md"), "---\nname: Changed\n---\nChanged body");

			await expect(saveSnippet(options, "global", draft({ body: "Updated" }), stale)).rejects.toThrow(
				/stale expected content/i,
			);
			expect(loadSnippets(options)[0]?.name).toBe("Changed");
		});

		it("rejects an edit whose file was deleted after the snapshot", async () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			writeFileSync(join(globalSnippetsDir, "test-rule.md"), "---\nname: X\n---\nBody");
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			rmSync(join(globalSnippetsDir, "test-rule.md"));

			await expect(saveSnippet(options, "global", draft(), prior)).rejects.toThrow(/removed|stale/i);
		});

		it("refuses to create through a symlinked snippet file", async () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			const victim = join(tempDir, "victim.md");
			writeFileSync(victim, "victim content");
			symlinkSync(victim, join(globalSnippetsDir, "test-rule.md"));

			await expect(saveSnippet(options, "global", draft(), null)).rejects.toThrow(/symlink/i);
			expect(readSnapshot(victim)).toBe("victim content");
		});

		it("refuses symlink snippet directories without writing the target", async () => {
			const elsewhere = join(tempDir, "elsewhere");
			mkdirSync(elsewhere, { recursive: true });
			symlinkSync(elsewhere, globalSnippetsDir);

			await expect(saveSnippet(options, "global", draft(), null)).rejects.toThrow(/symlink/i);
			expect(existsSync(join(elsewhere, "test-rule.md"))).toBe(false);
		});

		it("refuses targets that resolve inside the bundled directory via a parent symlink", async () => {
			symlinkSync(bundledDir, join(projectDir, ".pi"));

			await expect(saveSnippet(options, "project", draft(), null)).rejects.toThrow(/bundled/i);
			expect(existsSync(join(bundledDir, "snippets"))).toBe(false);
		});

		it("refuses the bundled directory itself as the global snippet directory", async () => {
			await expect(
				saveSnippet({ ...options, agentDir: bundledDir }, "global", draft(), null),
			).rejects.toThrow(/bundled/i);
			expect(readdirSync(bundledDir)).toEqual([]);
		});

		it("rejects invalid drafts without creating any directory or file", async () => {
			const badIds = ["../escape.md", "sub/evil.md", "..\\evil.md", "a:b.md", ".hidden.md", "notes.txt", "", ".."];
			for (const id of badIds) {
				await expect(saveSnippet(options, "global", draft({ id }), null)).rejects.toThrow();
			}
			await expect(saveSnippet(options, "global", draft({ name: "   " }), null)).rejects.toThrow(/name/i);
			await expect(saveSnippet(options, "global", draft({ name: "two\nlines" }), null)).rejects.toThrow(
				/single line/i,
			);
			await expect(
				saveSnippet(options, "global", draft({ description: "two\nlines" }), null),
			).rejects.toThrow(/single line/i);
			await expect(
				saveSnippet(options, "global", draft({ placement: "middle" as SnippetDraft["placement"] }), null),
			).rejects.toThrow(/placement/i);
			await expect(saveSnippet(options, "global", draft({ order: 1.5 }), null)).rejects.toThrow(/order/i);
			await expect(saveSnippet(options, "global", draft({ order: Number.NaN }), null)).rejects.toThrow(/order/i);
			await expect(saveSnippet(options, "global", draft({ body: "   " }), null)).rejects.toThrow(/body/i);
			await expect(saveSnippet(options, "global", undefined as unknown as SnippetDraft, null)).rejects.toThrow();

			expect(existsSync(globalSnippetsDir)).toBe(false);
			expect(existsSync(join(tempDir, "escape.md"))).toBe(false);
		});

		it("normalizes padded name, description, and body", async () => {
			await saveSnippet(
				options,
				"global",
				draft({ name: "  Padded Name  ", description: "  padded desc  ", body: "\n  padded body \n" }),
				null,
			);
			const loaded = loadSnippets(options)[0];
			expect(loaded).toMatchObject({
				name: "Padded Name",
				description: "padded desc",
				body: "padded body",
			});
		});

		it("writes only supported frontmatter keys, never hidden enabled/disabled metadata", async () => {
			await saveSnippet(options, "global", draft(), null);
			const raw = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			expect(raw.startsWith("---\nname: ")).toBe(true);
			expect(raw).not.toMatch(/^(disabled|enabled):/m);
		});

		it("replaces existing frontmatter entirely, dropping unknown keys", async () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			const prior = "---\nname: Old\nauthor: someone\n---\nOld body";
			writeFileSync(join(globalSnippetsDir, "test-rule.md"), prior);

			await saveSnippet(options, "global", draft({ name: "New" }), prior);

			const raw = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			expect(raw).not.toContain("author:");
			expect(loadSnippets(options)[0]).toMatchObject({ name: "New", body: "Always test the happy path." });
		});

		it.each([
			"plain",
			'"wrapped"',
			"'single'",
			'"',
			'""',
			'end"',
			'start"',
			'mid " quote',
			"it's here",
		])("round-trips quoted name %j through the loader", async (value) => {
			const d = draft({ id: "quoted.md", name: value });
			await saveSnippet(options, "global", d, null);

			const raw = readSnapshot(join(globalSnippetsDir, "quoted.md"))!;
			const parsed = parseSnippet("quoted.md", raw, "global", "");
			expect(parsed.disabled).toBe(false);
			expect(parsed.snippet?.name).toBe(value);
			expect(loadSnippets(options)[0]?.name).toBe(value);
		});

		it("round-trips tricky descriptions and bodies containing --- lines", async () => {
			const d = draft({
				id: "tricky.md",
				name: 'He said "hi"',
				description: '"leading" quote and trailing\'',
				body: "First line\n\n---\n\nSecond line\n--- at start also fine\n- item",
			});
			await saveSnippet(options, "global", d, null);

			const raw = readSnapshot(join(globalSnippetsDir, "tricky.md"))!;
			const parsed = parseSnippet("tricky.md", raw, "global", "");
			expect(parsed.snippet).toMatchObject({
				name: d.name,
				description: d.description,
				placement: d.placement,
				order: d.order,
				body: d.body,
			});
			const loaded = loadSnippets(options)[0];
			expect(loaded).toMatchObject({ name: d.name, description: d.description, body: d.body });
		});

		it("serializes same-file edits so exactly one of two concurrent saves wins", async () => {
			await saveSnippet(options, "global", draft(), null);
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			const results = await Promise.allSettled([
				saveSnippet(options, "global", draft({ body: "first edit" }), prior),
				saveSnippet(options, "global", draft({ body: "second edit" }), prior),
			]);

			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
			const after = readSnapshot(join(globalSnippetsDir, "test-rule.md")) ?? "";
			expect(after.includes("first edit") || after.includes("second edit")).toBe(true);
		});
	});

	describe("deleteSnippet", () => {
		it("deletes when the exact prior raw content matches", async () => {
			await saveSnippet(options, "global", draft(), null);
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			await deleteSnippet(options, "global", "test-rule.md", prior);

			expect(existsSync(join(globalSnippetsDir, "test-rule.md"))).toBe(false);
			expect(loadSnippets(options)).toHaveLength(0);
		});

		it("rejects stale expected content and keeps the file", async () => {
			await saveSnippet(options, "global", draft(), null);
			const stale = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			writeFileSync(join(globalSnippetsDir, "test-rule.md"), "---\nname: Changed\n---\nChanged body");

			await expect(deleteSnippet(options, "global", "test-rule.md", stale)).rejects.toThrow(
				/stale expected content/i,
			);
			expect(loadSnippets(options)).toHaveLength(1);
		});

		it("rejects deleting a missing snippet", async () => {
			await expect(deleteSnippet(options, "global", "missing.md", "anything")).rejects.toThrow(/not found/i);
		});

		it("requires the exact prior raw content as expected", async () => {
			await expect(
				deleteSnippet(options, "global", "test-rule.md", null as unknown as string),
			).rejects.toThrow(/expected/i);
		});

		it("refuses symlink files and rejects untrusted project scope", async () => {
			mkdirSync(globalSnippetsDir, { recursive: true });
			const real = join(tempDir, "real.md");
			writeFileSync(real, "real content");
			symlinkSync(real, join(globalSnippetsDir, "link.md"));
			await expect(deleteSnippet(options, "global", "link.md", "real content")).rejects.toThrow(/symlink/i);
			expect(readSnapshot(real)).toBe("real content");

			await expect(deleteSnippet({ ...options, isProjectTrusted: false }, "project", "x.md", "raw")).rejects.toThrow(
				/trusted/i,
			);
		});

		it("rejects path traversal ids", async () => {
			await expect(deleteSnippet(options, "global", "../escape.md", "raw")).rejects.toThrow();
			expect(existsSync(join(tempDir, "escape.md"))).toBe(false);
		});
	});

	describe("hideSnippet", () => {
		it("writes an exact disable tombstone that the loader honors", async () => {
			await saveSnippet(options, "global", draft(), null);
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			await hideSnippet(options, "global", "test-rule.md", prior);

			expect(readSnapshot(join(globalSnippetsDir, "test-rule.md"))).toBe("---\ndisabled: true\n---\n");
			expect(loadSnippets(options)).toHaveLength(0);
		});

		it("reveals a hidden bundled snippet again by deleting the tombstone", async () => {
			writeFileSync(join(bundledDir, "bundled-rule.md"), "---\nname: Bundled Rule\n---\nBundled body");
			await hideSnippet(options, "global", "bundled-rule.md", null);
			expect(loadSnippets(options).find((s) => s.id === "bundled-rule.md")).toBeUndefined();

			await deleteSnippet(options, "global", "bundled-rule.md", "---\ndisabled: true\n---\n");

			expect(loadSnippets(options).find((s) => s.id === "bundled-rule.md")).toMatchObject({
				name: "Bundled Rule",
				source: "bundled",
			});
		});

		it("reveals a tombstoned global snippet by saving content over the tombstone", async () => {
			await saveSnippet(options, "global", draft(), null);
			await hideSnippet(options, "global", "test-rule.md", readSnapshot(join(globalSnippetsDir, "test-rule.md"))!);
			const tombstone = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			await saveSnippet(options, "global", draft({ name: "Restored" }), tombstone);

			expect(loadSnippets(options)[0]).toMatchObject({ id: "test-rule.md", name: "Restored" });
		});

		it("hides a bundled snippet via a global tombstone without touching bundled files", async () => {
			writeFileSync(join(bundledDir, "bundled-rule.md"), "---\nname: Bundled Rule\n---\nBundled body");

			await hideSnippet(options, "global", "bundled-rule.md", null);

			expect(loadSnippets(options).find((s) => s.id === "bundled-rule.md")).toBeUndefined();
			expect(readdirSync(bundledDir)).toEqual(["bundled-rule.md"]);
			expect(loadSnippets({ ...options, cwd: undefined })).toHaveLength(0);
		});

		it("refuses to overwrite an existing file when expected is null", async () => {
			await saveSnippet(options, "global", draft(), null);
			await expect(hideSnippet(options, "global", "test-rule.md", null)).rejects.toThrow(/already exists/i);
			expect(loadSnippets(options)).toHaveLength(1);
		});

		it("replaces an existing snippet when the exact prior raw content matches", async () => {
			await saveSnippet(options, "global", draft(), null);
			const prior = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;

			await hideSnippet(options, "global", "test-rule.md", prior);

			expect(loadSnippets(options)).toHaveLength(0);
		});

		it("rejects stale expected content and keeps the snippet active", async () => {
			await saveSnippet(options, "global", draft(), null);
			const stale = readSnapshot(join(globalSnippetsDir, "test-rule.md"))!;
			writeFileSync(join(globalSnippetsDir, "test-rule.md"), "---\nname: Changed\n---\nChanged body");

			await expect(hideSnippet(options, "global", "test-rule.md", stale)).rejects.toThrow(
				/stale expected content/i,
			);
			expect(loadSnippets(options)).toHaveLength(1);
		});

		it("rejects untrusted project scope", async () => {
			await expect(
				hideSnippet({ ...options, isProjectTrusted: false }, "project", "x.md", null),
			).rejects.toThrow(/trusted/i);
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);
		});
	});
});
