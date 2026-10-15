import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadSnippets } from "../extensions/loader.js";
import { createSnippetManager } from "../extensions/management-ui.js";
import { createPromptSnippetsExtension } from "../extensions/prompt-snippets.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const bindings = { matches: (data: string, action: string) => ({
	"tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B",
} as Record<string, string>)[action] === data };
const raw = (name: string, body = "Original body") => `---\nname: ${name}\nplacement: append\norder: 10\n---\n${body}\n`;

describe("snippet management UI", () => {
	let root: string;
	let options: { cwd: string; agentDir: string; bundledDir: string; isProjectTrusted: boolean };
	let choices: (string | undefined)[];
	let keys: string[][];
	let bodies: (string | undefined)[];
	let confirmations: boolean[];
	let renders: string[];
	let ctx: ExtensionContext;
	let ui: any;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "snippet-management-"));
		options = { cwd: join(root, "project"), agentDir: join(root, "agent"), bundledDir: join(root, "bundled"), isProjectTrusted: true };
		for (const path of [options.cwd, options.bundledDir, join(options.agentDir, "snippets")]) mkdirSync(path, { recursive: true });
		choices = []; keys = []; bodies = []; confirmations = []; renders = [];
		ui = {
			theme, notify: vi.fn(), setWidget: vi.fn(),
			select: vi.fn(async (_title: string, items: string[]) => {
				if (!choices.length) throw new Error("Unexpected select");
				const choice = choices.shift();
				if (choice === undefined) return;
				const match = items.find((item) => item.startsWith(choice));
				if (!match) throw new Error(`Choice not available: ${choice}: ${items.join(", ")}`);
				return match;
			}),
			editor: vi.fn(async () => bodies.shift()),
			confirm: vi.fn(async () => confirmations.shift() ?? false),
			custom: vi.fn(async (factory: any) => {
				if (!keys.length) throw new Error("Unexpected custom screen");
				let result: unknown;
				let doneCount = 0;
				const component = factory({ terminal: { rows: 24 }, requestRender: vi.fn() }, theme, bindings, (value: unknown) => { result = value; doneCount++; });
				component.focused = true;
				for (const width of [20, 40, 100]) {
					for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
				renders.push(component.render(100).join("\n"));
				for (const key of keys.shift()!) {
					component.handleInput(key);
					renders.push(component.render(100).join("\n"));
				}
				expect(doneCount).toBe(1);
				return result;
			}),
		};
		ctx = { cwd: options.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => options.isProjectTrusted, ui } as unknown as ExtensionContext;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function file(scope: "bundled" | "global" | "project", id = "rule.md") {
		const dir = scope === "bundled" ? options.bundledDir : scope === "global" ? join(options.agentDir, "snippets") : join(options.cwd, ".pi", "snippets");
		mkdirSync(dir, { recursive: true });
		return join(dir, id);
	}
	function register() {
		const commands = new Map<string, any>();
		const listeners = new Map<string, any>();
		const pi = { on: (event: string, handler: any) => listeners.set(event, handler), registerShortcut: vi.fn(), registerCommand: (name: string, command: any) => commands.set(name, command), appendEntry: vi.fn() } as unknown as ExtensionAPI;
		createPromptSnippetsExtension(options)(pi);
		return { open: () => commands.get("snippets").handler("", ctx), input: (text: string) => listeners.get("input")({ text }, ctx) };
	}
	function expectNoErrors() {
		expect(ui.notify.mock.calls.filter((call: any[]) => call[1] === "error")).toEqual([]);
		expect(choices).toEqual([]);
	}

	it("creates from an empty Alt+S menu, and saved files survive cancelling toggles", async () => {
		choices.push("New snippet", "Global", "Name:", "Prompt body:", "Save snippet");
		bodies.push("New rule\nSecond line");
		keys.push(["\x05", " "], ["My rule", "\r"], ["\x1b"]); // Ctrl+E, then queued Space must not toggle.
		const extension = register();
		await extension.open();
		expect(readFileSync(file("global", "new-snippet.md"), "utf8")).toContain("New rule\nSecond line");
		expect(await extension.input("hello")).toBeUndefined();
		expect(renders.join("\n")).toContain("No snippets. Press Ctrl+E");
		expect(renders.join("\n")).toContain("[global]");
		expect(loadSnippets(options)[0].name).toBe("My rule");
		const nameScreen = renders.find((screen) => screen.startsWith("Edit name"))!;
		expect(nameScreen).not.toContain("New snippet");
		expect(ui.select.mock.calls.some(([, fields]: any[]) => fields.includes("Name: (required)"))).toBe(true);
		const details = ui.select.mock.calls.find(([title]: any[]) => title.startsWith("Snippet details"))[1];
		expect(details).toEqual([
			"Name: (required)", "Description: (none)", "Placement: append", "Order: 10",
			"Prompt body: (empty)", "Filename: new-snippet.md", "Save snippet", "Discard changes",
		]);
		expect(ui.editor).toHaveBeenCalledWith(expect.stringContaining("instructions inserted into your message"), "");
		expectNoErrors();
	});

	it("preserves pending toggles and cursor through editing, applies only on Enter", async () => {
		writeFileSync(file("global", "a.md"), raw("A"));
		writeFileSync(file("global", "b.md"), raw("B"));
		choices.push("Edit snippet", "Prompt body:", "Save snippet");
		bodies.push("Edited B");
		keys.push([" ", "\x1b[B", "\x05"], ["\t", "\x1b", " ", "\r", " "]);
		const extension = register();
		await extension.open();
		expect(renders.join("\n")).toContain("Preview: B");
		const result = await extension.input("hello");
		expect(result.text).toBe("hello\n\nOriginal body\n\nEdited B");
		expectNoErrors();
	});

	it("keeps saved edits but discards toggle changes on Esc", async () => {
		writeFileSync(file("global"), raw("Rule"));
		const extension = register();
		keys.push([" ", "\r"]);
		await extension.open();
		choices.push("Edit snippet", "Prompt body:", "Save snippet");
		bodies.push("Saved body");
		keys.push([" ", "\x05"], ["\x1b"]);
		await extension.open();
		expect((await extension.input("hello")).text).toBe("hello\n\nSaved body");
		expectNoErrors();
	});

	it("prefills single-line metadata and requires explicit Save", async () => {
		writeFileSync(file("global"), raw("Rule"));
		choices.push("Edit snippet", "Name:", "Description:", "Order:", "Placement:", "prepend", "Save snippet");
		keys.push(["\x0b", "Renamed", "\r"], ["Detailed rule", "\r"], ["\x0b", "20", "\r"]);
		await createSnippetManager()(ctx, options, "rule.md");
		const snippet = loadSnippets(options)[0];
		expect(snippet).toMatchObject({ name: "Renamed", description: "Detailed rule", order: 20, placement: "prepend" });
		expect(stripVTControlCharacters(renders[0])).toContain("Rule");
		const text = stripVTControlCharacters(renders.join("\n")).replace(/\s+/g, " ");
		expect(text).toContain("Display name in the snippet menu");
		expect(text).toContain("Not sent to the model");
		expect(text).toContain("Lower numbers appear first: 10 before 20");
		expect(text).toContain("Ties sort by name. This is not instruction priority");
		expect(ui.select).toHaveBeenCalledWith(expect.stringContaining("Prepend inserts instructions before your message"), ["prepend", "append"]);
		expectNoErrors();
	});

	it("uses a separate dimmed Tip line for every field, including placement and prompt body", async () => {
		const fg = vi.spyOn(theme, "fg");
		try {
			choices.push("New snippet", "Global", "Name:", "Description:", "Order:", "Placement:", "prepend", "Prompt body:", "Filename:", "Save snippet");
			keys.push(["Rule", "\r"], ["Subtitle", "\r"], ["\x0b", "20", "\r"], ["\x0b", "rule.md", "\r"]);
			bodies.push("Only these instructions");
			await createSnippetManager()(ctx, options);

			for (const field of ["name", "description", "order", "filename"]) {
				const screen = renders.find((screen) => screen.startsWith(`Edit ${field}\n`));
				expect(screen?.split("\n")[1]).toMatch(/^Tip: /);
			}
			const placementTitle = ui.select.mock.calls.find(([title]: any[]) => title.startsWith("Edit placement"))[0];
			const bodyTitle = ui.editor.mock.calls[0][0];
			expect(placementTitle).toMatch(/^Edit placement\nTip: Prepend inserts instructions/);
			expect(bodyTitle).toMatch(/^Edit prompt body\nTip: The instructions inserted into your message/);
			expect(bodyTitle.split("\n")).toHaveLength(2);
			for (const prefix of ["Display name", "Optional subtitle", "Whole number", "Unique .md", "Prepend inserts", "The instructions"]) {
				expect(fg).toHaveBeenCalledWith("dim", expect.stringMatching(new RegExp(`^Tip: ${prefix.replace(/[.]/g, "\\.")}`)));
			}
			expect(loadSnippets(options)[0].body).toBe("Only these instructions");
			expectNoErrors();
		} finally {
			fg.mockRestore();
		}
	});

	it("discards changes without writing and cancelling a field leaves it unchanged", async () => {
		const path = file("global");
		writeFileSync(path, raw("Rule"));
		const before = readFileSync(path, "utf8");
		choices.push("Edit snippet", "Name:", "Prompt body:", "Discard changes");
		keys.push(["\x0b", "Not saved", "\x1b"]);
		bodies.push("Unsaved body");
		confirmations.push(true);
		await createSnippetManager()(ctx, options, "rule.md");
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(ui.confirm).toHaveBeenCalledWith("Discard unsaved snippet?", expect.any(String));
		expectNoErrors();
	});

	it("edits bundled content into a project override and remembers scope for a new snippet", async () => {
		const path = file("bundled");
		writeFileSync(path, raw("Bundled"));
		const manager = createSnippetManager();
		choices.push("Edit snippet", "This project", "Prompt body:", "Save snippet");
		bodies.push("Project override");
		await manager(ctx, options, "rule.md");
		expect(readFileSync(path, "utf8")).toBe(raw("Bundled"));
		expect(loadSnippets(options)[0]).toMatchObject({ source: "project", body: "Project override" });
		choices.push("New snippet", undefined);
		await manager(ctx, options);
		expect(ui.select.mock.calls.at(-1)[1][0]).toMatch(/^This project/);
		expectNoErrors();
	});

	it("does not delete without confirmation and explains override fallback", async () => {
		writeFileSync(file("global"), raw("Global"));
		writeFileSync(file("project"), raw("Project"));
		const manager = createSnippetManager();
		choices.push("Delete snippet");
		confirmations.push(false);
		await manager(ctx, options, "rule.md");
		expect(existsSync(file("project"))).toBe(true);
		expect(ui.confirm).toHaveBeenLastCalledWith("Delete snippet file?", expect.stringContaining("Restore global version: Global"));
		choices.push("Delete snippet");
		confirmations.push(true);
		await manager(ctx, options, "rule.md");
		expect(loadSnippets(options)[0]).toMatchObject({ source: "global" });
		expectNoErrors();
	});

	it("duplicates without overwriting a colliding file and allows choosing another filename", async () => {
		writeFileSync(file("global"), raw("Rule"));
		writeFileSync(file("global", "rule-copy.md"), raw("Existing copy"));
		choices.push("Duplicate snippet", "Global", "Save snippet", "Filename:", "Save snippet");
		keys.push(["\x0b", "another.md", "\r"]);
		await createSnippetManager()(ctx, options, "rule.md");
		expect(readFileSync(file("global", "rule-copy.md"), "utf8")).toBe(raw("Existing copy"));
		expect(loadSnippets(options).find((s) => s.id === "another.md")?.body).toBe("Original body");
		expect(ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
		expect(stripVTControlCharacters(renders.join("\n")).replace(/\s+/g, " ")).toContain("This is the snippet ID");
		expect(choices).toEqual([]);
	});

	it("hides and restores bundled snippets without touching the bundle", async () => {
		const path = file("bundled");
		writeFileSync(path, raw("Bundled"));
		const manager = createSnippetManager();
		choices.push("Hide snippet", "Global");
		confirmations.push(true);
		await manager(ctx, options, "rule.md");
		expect(loadSnippets(options)).toEqual([]);
		choices.push("Restore hidden snippet", "rule.md [global]");
		confirmations.push(true);
		await manager(ctx, options);
		expect(loadSnippets(options)[0]).toMatchObject({ source: "bundled" });
		expect(readFileSync(path, "utf8")).toBe(raw("Bundled"));
		expectNoErrors();
	});

	it("restores hiding files despite unrelated symlinks and preserves disabled prompt bodies", async () => {
		writeFileSync(file("bundled"), raw("Bundled"));
		const manager = createSnippetManager();
		choices.push("Hide snippet", "Global");
		confirmations.push(true);
		await manager(ctx, options, "rule.md");
		symlinkSync(file("bundled"), file("global", "a-link.md"));
		const disabledBody = "---\ndisabled: true\n---\nKeep this body";
		writeFileSync(file("global", "disabled.md"), disabledBody);
		choices.push("Restore hidden snippet", "rule.md [global]");
		confirmations.push(true);
		await manager(ctx, options);
		expect(loadSnippets(options).find((s) => s.id === "rule.md")?.source).toBe("bundled");
		expect(readFileSync(file("global", "disabled.md"), "utf8")).toBe(disabledBody);
		expectNoErrors();
	});

	it("does not offer project writes for an untrusted project", async () => {
		options.isProjectTrusted = false;
		choices.push("New snippet", undefined);
		await createSnippetManager()(ctx, options);
		expect(ui.select.mock.calls[1][1]).toHaveLength(1);
		expect(ui.select.mock.calls[1][1][0]).toMatch(/^Global/);
		expectNoErrors();
	});

	it("keeps an active selection usable after deleting its final snippet", async () => {
		writeFileSync(file("global"), raw("Rule"));
		const extension = register();
		keys.push([" ", "\r"]);
		await extension.open();
		choices.push("Delete snippet");
		confirmations.push(true);
		keys.push(["\x05"], [" ", "\t", "\x1b[A", "\x1b[B", "\r"]);
		await extension.open();
		expect(await extension.input("hello")).toBeUndefined();
		expectNoErrors();
	});
});
