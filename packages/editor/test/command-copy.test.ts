import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import editorExtension, { NamedSessionEditor } from "../extensions/editor.js";
import { CommandCopyMenu } from "../lib/command-copy.js";
import type { ShellCommand } from "../lib/shell-commands.js";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	copyToClipboard: vi.fn(),
	getSelectListTheme: () => ({
		selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
		description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text,
	}),
}));

const actions: Record<string, string[]> = {
	"tui.select.up": ["up"], "tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"],
	"tui.input.submit": ["enter"], "app.message.followUp": ["alt+enter"],
};
const keybindings = { matches: (data: string, action: string) => (actions[action] ?? []).some(key => matchesKey(data, key as never)) };
const theme = { fg: (_color: string, text: string) => text };
const editorTheme = { borderColor: (text: string) => text, selectList: {} as never };
const makeTui = () => ({
	terminal: { rows: 24, write: vi.fn() }, requestRender: vi.fn(),
	setShowHardwareCursor: vi.fn(), getShowHardwareCursor: () => true, setFocus: vi.fn(),
});
const command = (text: string, index = 0): ShellCommand => ({ id: `a:${index}`, text, language: "bash", reply: 0 });
const type = (editor: NamedSessionEditor, text: string) => { for (const char of text) editor.handleInput(char); };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function setup(commands = [command("npm test"), command("git status", 1)]) {
	const tui = makeTui();
	const editor = new NamedSessionEditor(tui as never, editorTheme, keybindings as never, () => undefined, () => ({} as never), () => true);
	const createMenu = vi.fn(() => new CommandCopyMenu(commands, tui as never, () => theme as never, keybindings as never));
	const status = vi.fn();
	const submit = vi.fn();
	editor.onCopyCommand = createMenu;
	editor.onCopyStatus = status;
	editor.onSubmit = submit;
	return { editor, tui, createMenu, status, submit };
}

beforeEach(() => vi.mocked(copyToClipboard).mockReset());

describe("inline copy interaction", () => {
	it("preserves the editable prefix and previews even one candidate before copying", async () => {
		const { editor, submit, tui, status } = setup([command("npm test")]);
		type(editor, "$$");
		expect(editor.getText()).toBe("$$");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(editor.render(60).join("\n")).toContain("R0 · bash");
		editor.handleInput("\r");
		await tick();
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("npm test");
		expect(editor.getText()).toBe("");
		expect(editor.render(60).join("\n")).not.toContain("Copy command");
		expect(status).toHaveBeenCalledWith(expect.stringContaining("best effort"), "info");
		expect(submit).not.toHaveBeenCalled();
		expect(tui.setFocus).not.toHaveBeenCalled();
	});
	it("filters with $$git and copies the chosen multiline block intact", async () => {
		const script = "git status\ncat <<'EOF'\n  $literal\nEOF\necho done \\\n  continued";
		const { editor } = setup([command("npm test"), command(script, 1)]);
		type(editor, "$$git");
		expect(editor.getText()).toBe("$$git");
		editor.handleInput("\r");
		await tick();
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(script);
	});
	it("routes navigation to the menu without prompt history or text mutations", async () => {
		const { editor, submit } = setup();
		type(editor, "$$");
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("$$");
		editor.handleInput("\r");
		await tick();
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("git status");
		expect(submit).not.toHaveBeenCalled();
	});
	it("never submits copy queries with Enter or follow-up keys, including no matches", async () => {
		const { editor, submit } = setup();
		type(editor, "$$no-match");
		expect(editor.render(60).join("\n")).toContain("No matching shell code blocks");
		editor.handleInput("\r");
		editor.handleInput("\x1b\r");
		editor.handleInput("\t");
		await tick();
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("$$no-match");
	});
	it("shows an empty menu without copying or submitting when there are no shell blocks", () => {
		const { editor, submit } = setup([]);
		type(editor, "$$");
		expect(editor.render(60).join("\n")).toContain("No shell code blocks");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});
	it("Escape and Ctrl+C hide the menu without touching the clipboard or prefix", () => {
		for (const cancel of ["\x1b", "\x03"]) {
			const { editor } = setup();
			type(editor, "$$git");
			editor.handleInput(cancel);
			expect(editor.getText()).toBe("$$git");
			expect(editor.vimMode).toBe("insert");
			expect(editor.render(60).join("\n")).not.toContain("Copy command");
		}
		expect(copyToClipboard).not.toHaveBeenCalled();
	});
	it("Enter after hiding reopens the preview rather than copying unseen content or submitting", () => {
		const { editor, submit } = setup();
		type(editor, "$$");
		editor.handleInput("\x1b");
		editor.handleInput("\r");
		expect(editor.render(60).join("\n")).toContain("Copy command");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});
	it("keeps the prefix and menu for retry after clipboard failure", async () => {
		vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable"));
		const { editor, status } = setup();
		type(editor, "$$");
		editor.handleInput("\r");
		await tick();
		expect(status).toHaveBeenCalledWith("Command copy failed: Clipboard unavailable", "error");
		expect(editor.getText()).toBe("$$");
		expect(editor.render(60).join("\n")).toContain("Copy command");
		editor.handleInput("\r");
		await tick();
		expect(copyToClipboard).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("");
	});
	it("bounds reentrant copies and does not erase edits made while the clipboard is pending", async () => {
		let resolve!: () => void;
		vi.mocked(copyToClipboard).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
		const { editor, status } = setup();
		type(editor, "$$");
		editor.handleInput("\r");
		editor.handleInput("\r");
		expect(copyToClipboard).toHaveBeenCalledOnce();
		type(editor, "git");
		resolve();
		await tick();
		expect(editor.getText()).toBe("$$git");
		expect(status).not.toHaveBeenCalled();
	});
	it("does not clear a new draft or notify after disposal with a pending clipboard write", async () => {
		let resolve!: () => void;
		vi.mocked(copyToClipboard).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
		const { editor, status } = setup();
		type(editor, "$$");
		editor.handleInput("\r");
		editor.setText("new draft");
		editor.dispose();
		resolve();
		await tick();
		expect(editor.getText()).toBe("new draft");
		expect(status).not.toHaveBeenCalled();
	});
	it("reports extraction failures without submitting the copy query", () => {
		const { editor, status, submit } = setup();
		editor.onCopyCommand = () => { throw new Error("Unreadable session"); };
		type(editor, "$$");
		expect(status).toHaveBeenCalledWith("Command copy failed: Unreadable session", "error");
		editor.handleInput("\r");
		expect(submit).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});
});

describe("inline menu rendering and filtering", () => {
	function menu(commands = [command("npm test"), command("git status", 1)]) {
		const tui = makeTui();
		const menu = new CommandCopyMenu(commands, tui as never, () => theme as never, keybindings as never);
		return { menu, tui };
	}
	it("uses zero-based reply labels in both the list and selected preview", () => {
		const { menu: m } = menu([command("echo latest"), { ...command("echo previous", 1), reply: 1 }]);
		const latest = m.render(80);
		expect(latest.filter(line => line.includes("R0 · bash"))).toHaveLength(2);
		expect(latest.join("\n")).toContain("R1 · bash");
		m.handleInput("\x1b[B");
		expect(m.render(80).filter(line => line.includes("R1 · bash"))).toHaveLength(2);
	});
	it("filters shell text case-insensitively and retains a still-matching selection", () => {
		const { menu: m } = menu([command("git status"), command("git diff", 1), command("npm test", 2)]);
		m.handleInput("\x1b[B");
		m.setQuery(" Git ");
		expect(m.selected?.text).toBe("git diff");
		m.setQuery("npm");
		expect(m.selected?.text).toBe("npm test");
		m.setQuery("unmatched");
		expect(m.selected).toBeUndefined();
		m.handleInput("\x1b[B");
		m.setQuery("");
		expect(m.selected?.text).toBe("git status");
	});
	it("bounds long/wide/control-character previews and supports explicit preview scrolling", () => {
		const commands = [command(Array.from({ length: 40 }, (_, i) => `echo row-${i} 😀中`).join("\n") + "\n\x1b[2J")];
		const { menu: m, tui } = menu(commands);
		const first = m.render(32, 16).map(stripTerminalSequences);
		expect(first.length).toBeLessThanOrEqual(16);
		expect(first.every(line => visibleWidth(line) <= 32)).toBe(true);
		expect(first.join("\n")).not.toContain("row-39");
		expect(m.handleInput("\x1b[C")).toBe(false); // plain right is editor cursor movement
		m.handleInput("\x1b[1;5C");
		expect(m.render(32, 16).join("\n")).toContain("row-5");
		for (let i = 0; i < 10; i++) m.handleInput("\x1b[1;5C");
		expect(m.render(32, 16).join("\n")).toContain("\\x1b[2J");
		expect(tui.requestRender).toHaveBeenCalled();
	});
	it("preserves selection across resize, and always fits the available editor-adjacent space", () => {
		const { menu: m } = menu();
		m.handleInput("\x1b[B");
		for (const height of [2, 4, 8, 20]) {
			for (const width of [1, 2, 3, 12, 80]) {
				const lines = m.render(width, height);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
			}
		}
		m.invalidate();
		expect(m.selected?.text).toBe("git status");
		expect(m.render(0)).toEqual([]);
		expect(m.render(20, 0)).toEqual([]);
	});
	it("respects injected selection bindings without stealing typing or plain cursor keys", () => {
		const customKeys = { matches: (data: string, action: string) => data === action };
		const commands = Array.from({ length: 10 }, (_, i) => command(`echo ${i}`, i));
		const m = new CommandCopyMenu(commands, makeTui() as never, () => theme as never, customKeys as never);
		m.handleInput("tui.select.pageDown");
		m.handleInput("tui.select.up");
		expect(m.selected).toEqual(commands[4]);
		expect(m.handleInput("g")).toBe(false);
		expect(m.handleInput("\x1b[D")).toBe(false);
	});
});

describe("extension wiring", () => {
	function harness(mode = "tui") {
		const handlers = new Map<string, (event: never, ctx: never) => void>();
		let commandHandler!: (args: string, ctx: ExtensionContext) => Promise<void>;
		const pi = {
			on: vi.fn((event: string, handler: (event: never, ctx: never) => void) => { handlers.set(event, handler); }),
			registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => { commandHandler = command.handler; }),
		};
		editorExtension(pi as never);
		let factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
		let editor: NamedSessionEditor | undefined;
		const tui = makeTui();
		const ui = {
			theme, notify: vi.fn(), custom: vi.fn(),
			getEditorComponent: vi.fn(() => factory),
			setEditorComponent: vi.fn((next: typeof factory) => {
				factory = next;
				if (next) editor = next(tui as never, editorTheme, keybindings as never) as NamedSessionEditor;
			}),
		};
		const ctx = {
			mode, hasUI: mode === "tui", ui,
			sessionManager: {
				getSessionName: () => undefined,
				getBranch: () => [{ type: "message", id: "a", message: {
					role: "assistant", stopReason: "stop", content: [
						{ type: "toolCall", name: "bash", arguments: { command: "echo tool-excluded" } },
						{ type: "text", text: "```bash\necho prose-only\n```" },
					],
				} }],
			},
		} as unknown as ExtensionContext;
		const start = () => handlers.get("session_start")!(undefined as never, ctx as never);
		const stop = () => {
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			try { handlers.get("session_shutdown")!(undefined as never, ctx as never); } finally { stdout.mockRestore(); }
		};
		return { start, stop, ui, ctx, command: () => commandHandler("", ctx), get editor() { return editor!; } };
	}
	it("slash command enters the same inline prefix mode, without custom UI or tool-call candidates", async () => {
		const h = harness();
		try {
			h.start();
			await h.command();
			expect(h.editor.getText()).toBe("$$");
			const rendered = h.editor.render(80).join("\n");
			expect(rendered).toContain("echo prose-only");
			expect(rendered).not.toContain("tool-excluded");
			expect(h.ui.custom).not.toHaveBeenCalled();
		} finally { h.stop(); }
	});
	it("refuses to overwrite an existing draft and cleans up the inline menu on shutdown", async () => {
		const h = harness();
		try {
			h.start();
			h.editor.setText("existing draft");
			await h.command();
			expect(h.editor.getText()).toBe("existing draft");
			expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Clear the editor"), "error");
			h.editor.setText("");
			type(h.editor, "$$");
			expect(h.editor.render(80).join("\n")).toContain("Copy command");
		} finally { h.stop(); }
		expect(h.editor.render(80).join("\n")).not.toContain("Copy command");
	});
	it.each(["rpc", "json", "print"])("does not install a terminal editor or menu in %s mode", async mode => {
		const h = harness(mode);
		h.start();
		await h.command();
		expect(h.ui.setEditorComponent).not.toHaveBeenCalled();
		expect(h.ui.custom).not.toHaveBeenCalled();
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("requires"), "error");
	});
});
