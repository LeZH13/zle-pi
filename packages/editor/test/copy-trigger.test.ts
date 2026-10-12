import { CURSOR_MARKER, matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { NamedSessionEditor } from "../extensions/editor.js";

function setup() {
	const tui = {
		terminal: { rows: 24, write: vi.fn() }, requestRender: vi.fn(),
		setShowHardwareCursor: vi.fn(), getShowHardwareCursor: () => true, setFocus: vi.fn(),
	};
	const editor = new NamedSessionEditor(
		tui as never, { borderColor: (text: string) => text, selectList: {} as never },
		{ matches: (data: string, action: string) => action === "tui.input.submit" && matchesKey(data, "enter") } as never,
		() => undefined,
	);
	editor.focused = true;
	const menu = {
		setQuery: vi.fn(), handleInput: vi.fn(() => false), render: vi.fn(() => ["COPY MENU"]), invalidate: vi.fn(),
	};
	const createMenu = vi.fn(() => menu as never);
	editor.onCopyCommand = createMenu;
	return { editor, menu, createMenu, tui };
}

const type = (editor: NamedSessionEditor, text: string) => {
	for (const char of text) editor.handleInput(char);
};
const rendered = (editor: NamedSessionEditor) => editor.render(60).map(stripTerminalSequences).join("\n");

describe("editable initial $$ command-copy prefix", () => {
	it("opens immediately without consuming $$, replacing the editor, or changing focus", () => {
		const { editor, createMenu, tui } = setup();
		editor.handleInput("$");
		expect(createMenu).not.toHaveBeenCalled();
		editor.handleInput("$");
		expect(createMenu).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("$$");
		expect(editor.vimMode).toBe("insert");
		const lines = editor.render(60);
		expect(lines.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1);
		expect(rendered(editor)).toContain("COPY MENU");
		expect(rendered(editor)).toContain("INSERT");
		expect(tui.setFocus).not.toHaveBeenCalled();
	});
	it("recognizes protocol-encoded dollar keys", () => {
		const { editor, createMenu } = setup();
		editor.handleInput("\x1b[36u");
		editor.handleInput("\x1b[36u");
		expect(createMenu).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("$$");
	});
	it("deleting a dollar hides the menu; typing it again reopens it", () => {
		const { editor, createMenu } = setup();
		type(editor, "$$");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("$");
		expect(rendered(editor)).not.toContain("COPY MENU");
		type(editor, "$");
		expect(editor.getText()).toBe("$$");
		expect(createMenu).toHaveBeenCalledTimes(2);
		expect(rendered(editor)).toContain("COPY MENU");
	});
	it("filters while typing and preserves plain left/right cursor editing", () => {
		const { editor, menu } = setup();
		type(editor, "$$git");
		expect(editor.getText()).toBe("$$git");
		expect(menu.setQuery).toHaveBeenLastCalledWith("git");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("$$gt");
		expect(menu.setQuery).toHaveBeenLastCalledWith("gt");
	});
	it("deleting either leading dollar hides the menu, including with a query", () => {
		const { editor, createMenu, menu } = setup();
		type(editor, "$$git");
		editor.handleInput("\x01"); // line start
		editor.handleInput("\x1b[3~"); // forward-delete first dollar
		expect(editor.getText()).toBe("$git");
		expect(rendered(editor)).not.toContain("COPY MENU");
		type(editor, "$");
		expect(editor.getText()).toBe("$$git");
		expect(createMenu).toHaveBeenCalledTimes(2);
		expect(menu.setQuery).toHaveBeenLastCalledWith("git");
	});
	it("Escape hides the menu but leaves the editable prefix in INSERT; editing reopens it", () => {
		const { editor, menu } = setup();
		type(editor, "$$");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("$$");
		expect(editor.vimMode).toBe("insert");
		expect(rendered(editor)).not.toContain("COPY MENU");
		type(editor, "git");
		expect(rendered(editor)).toContain("COPY MENU");
		expect(menu.setQuery).toHaveBeenLastCalledWith("git");
		editor.handleInput("\x1b");
		editor.handleInput("\x1b");
		expect(editor.vimMode).toBe("normal");
	});
	it.each(["$HOME", "ask $$", "\n$$", " $$"])("leaves ordinary input %j alone", text => {
		const { editor, createMenu } = setup();
		type(editor, text);
		expect(createMenu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe(text);
	});
	it("preserves NORMAL-mode dollar motions, including an empty prompt", () => {
		const { editor, createMenu } = setup();
		editor.handleInput("\x1b");
		type(editor, "$$");
		expect(editor.vimMode).toBe("normal");
		expect(editor.getText()).toBe("");
		editor.setText("abc");
		type(editor, "0$$");
		expect(editor.getText()).toBe("abc");
		expect(createMenu).not.toHaveBeenCalled();
	});
	it.each([
		["\x1b[200~$$\x1b[201~"],
		["\x1b[200~", "$", "$", "\x1b[201~"],
		["$$"],
	].map(chunks => ({ chunks })))("never opens from an initial paste: $chunks", ({ chunks }) => {
		const { editor, createMenu } = setup();
		for (const chunk of chunks) editor.handleInput(chunk);
		expect(createMenu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("$$");
	});
	it("allows pasted query text after deliberate activation", () => {
		const { editor, menu, createMenu } = setup();
		type(editor, "$$");
		editor.handleInput("\x1b[200~git\x1b[201~");
		expect(editor.getExpandedText()).toBe("$$git");
		expect(menu.setQuery).toHaveBeenLastCalledWith("git");
		expect(createMenu).toHaveBeenCalledOnce();
	});
	it("disarms an initial trigger after intervening keys or programmatic changes", () => {
		const { editor, createMenu } = setup();
		type(editor, "$");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[C");
		type(editor, "$");
		expect(createMenu).not.toHaveBeenCalled();
		editor.setText("");
		type(editor, "$");
		editor.setText("$");
		type(editor, "$");
		expect(createMenu).not.toHaveBeenCalled();
	});
	it("programmatic text changes dismiss an existing menu", () => {
		const { editor } = setup();
		type(editor, "$$");
		editor.setText("a new draft");
		expect(rendered(editor)).not.toContain("COPY MENU");
		expect(editor.getText()).toBe("a new draft");
	});
	it("keeps $$ ordinary if there is no menu factory", () => {
		const { editor } = setup();
		editor.onCopyCommand = undefined;
		type(editor, "$$");
		expect(editor.getText()).toBe("$$");
	});
});
