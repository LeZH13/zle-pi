import { describe, expect, it, vi } from "vitest";
import { NamedSessionEditor } from "../extensions/editor.js";

function makeEditor(): NamedSessionEditor {
	return new NamedSessionEditor(
		{ requestRender: () => {}, scheduleRender: () => {}, getColorDepth: () => 4 } as never,
		{ borderColor: (text: string) => text, selectList: {}, text: (text: string) => text } as never,
		{ matches: () => false } as never,
		() => "my-session",
		() => ({} as never),
		() => true,
	);
}
const cursor = (editor: NamedSessionEditor) =>
	(editor as unknown as { state: { cursorLine: number; cursorCol: number } }).state;
const keys = (editor: NamedSessionEditor, ...inputs: string[]) => inputs.forEach((key) => editor.handleInput(key));
const type = (editor: NamedSessionEditor, text: string) => { for (const char of text) editor.handleInput(char); };

describe("real-editor vim commands", () => {
	it("O opens above and typing goes on the new line; o opens below", () => {
		const editor = makeEditor();
		type(editor, "first"); keys(editor, "\n"); type(editor, "second");
		keys(editor, "\x1b", "O"); type(editor, "above");
		expect(editor.getText()).toBe("first\nabove\nsecond");
		expect(cursor(editor).cursorLine).toBe(1);
		keys(editor, "\x1b", "o"); type(editor, "below");
		expect(editor.getText()).toBe("first\nabove\nbelow\nsecond");
	});
	it("x deletes only characters on the current line, including emoji; s enters insert", () => {
		const editor = makeEditor();
		type(editor, "a😀c"); keys(editor, "\n"); type(editor, "next");
		keys(editor, "\x1b", "0", "x");
		expect(editor.getText()).toBe("a😀c\next");
		keys(editor, "k", "0", "l", "x");
		expect(editor.getText()).toBe("ac\next");
		keys(editor, "s"); type(editor, "Z");
		expect(editor.getText()).toBe("aZ\next");
	});
	it("dw removes trailing whitespace and cw preserves it", () => {
		const editor = makeEditor();
		type(editor, "foo   bar"); keys(editor, "\x1b", "0", "d", "w");
		expect(editor.getText()).toBe("bar");
		keys(editor, "c", "w"); type(editor, "baz");
		expect(editor.getText()).toBe("baz");
	});
	it("dd deletes entire lines, cc changes a line, and undo restores each action", () => {
		const editor = makeEditor();
		type(editor, "one"); keys(editor, "\n"); type(editor, "two"); keys(editor, "\n"); type(editor, "three");
		keys(editor, "\x1b", "k", "d", "d");
		expect(editor.getText()).toBe("one\nthree");
		keys(editor, "u");
		expect(editor.getText()).toBe("one\ntwo\nthree");
		keys(editor, "c", "c"); type(editor, "new");
		expect(editor.getText()).toBe("one\nnew\nthree");
	});
	it("motions do not browse history, and land at Vim word and line boundaries", () => {
		const editor = makeEditor();
		type(editor, "  foo bar"); keys(editor, "\n"); type(editor, "next");
		keys(editor, "\x1b", "k", "^");
		expect(cursor(editor).cursorLine).toBe(0);
		expect(cursor(editor).cursorCol).toBe(2);
		keys(editor, "w"); expect(cursor(editor).cursorCol).toBe(6);
		keys(editor, "b"); expect(cursor(editor).cursorCol).toBe(2);
		editor.addToHistory("old prompt");
		keys(editor, "k"); expect(editor.getText()).toBe("  foo bar\nnext");
		keys(editor, "e"); expect(cursor(editor).cursorCol).toBe(4);
		keys(editor, "e"); expect(cursor(editor).cursorCol).toBe(8);
		keys(editor, "I"); type(editor, "X");
		expect(editor.getText()).toBe("  Xfoo bar\nnext");
	});
	it("counts apply to motions, word deletes, line deletes, and undo", () => {
		const editor = makeEditor();
		type(editor, "one two three four"); keys(editor, "\x1b", "0", "2", "d", "w");
		expect(editor.getText()).toBe("three four");
		keys(editor, "u"); expect(editor.getText()).toBe("one two three four");
		keys(editor, "2", "w"); expect(cursor(editor).cursorCol).toBe(8);
	});
	it("escape cancels a pending operator; unowned controls clear it too", () => {
		const editor = makeEditor();
		const interrupt = vi.fn(); editor.onEscape = interrupt;
		keys(editor, "\x1b", "3", "d", "\x1b");
		expect(interrupt).not.toHaveBeenCalled();
		keys(editor, "d", "\x03", "d"); // ctrl+c clears the pending d
		expect(editor.getText()).toBe("");
		keys(editor, "\x1b");
		expect(editor.vimMode).toBe("normal");
	});
	it("line-end changes preserve the newline, and counts delete whole lines", () => {
		const editor = makeEditor();
		type(editor, "alpha beta"); keys(editor, "\n"); type(editor, "second"); keys(editor, "\n"); type(editor, "third");
		keys(editor, "\x1b", "k", "0", "d", "$");
		expect(editor.getText()).toBe("alpha beta\n\nthird");
		keys(editor, "2", "d", "d");
		expect(editor.getText()).toBe("alpha beta");
		keys(editor, "u", "u");
		expect(editor.getText()).toBe("alpha beta\nsecond\nthird");
		keys(editor, "k", "0", "C"); type(editor, "changed");
		expect(editor.getText()).toBe("changed\nsecond\nthird");
	});
	it("cursor motions respect multicode-unit graphemes", () => {
		const editor = makeEditor();
		type(editor, "a😀b"); keys(editor, "\x1b", "0", "l");
		expect(cursor(editor).cursorCol).toBe(1);
		keys(editor, "l"); expect(cursor(editor).cursorCol).toBe(3);
		keys(editor, "h"); expect(cursor(editor).cursorCol).toBe(1);
		keys(editor, "x"); expect(editor.getText()).toBe("ab");
	});
	it("j/k retain the intended column across shorter lines", () => {
		const editor = makeEditor();
		type(editor, "abcdef"); keys(editor, "\n"); type(editor, "x"); keys(editor, "\n"); type(editor, "abcdef");
		keys(editor, "\x1b", "k", "k", "0", "4", "l", "j", "j");
		expect(cursor(editor)).toMatchObject({ cursorLine: 2, cursorCol: 4 });
	});
	it("normal mode ignores bracketed paste without interpreting pasted commands", () => {
		const editor = makeEditor();
		type(editor, "original"); keys(editor, "\x1b", "\x1b[200~", "x", "i\x1b[201~");
		expect(editor.getText()).toBe("original");
		expect(editor.vimMode).toBe("normal");
	});
	it("large-paste markers remain atomic during normal-mode deletion", () => {
		const editor = makeEditor();
		editor.handleInput(`\x1b[200~${"p".repeat(1001)}\x1b[201~`);
		expect(editor.getText()).toMatch(/^\[paste #1 /u);
		keys(editor, "\x1b", "x");
		expect(editor.getText()).toBe("");
		keys(editor, "u");
		expect(editor.getExpandedText()).toBe("p".repeat(1001));
	});
	it("a normal-mode edit dismisses stale autocomplete", () => {
		const editor = makeEditor();
		type(editor, "abc"); keys(editor, "\x1b", "0");
		const cancel = vi.spyOn(editor as unknown as { cancelAutocomplete(): void }, "cancelAutocomplete");
		keys(editor, "x");
		expect(cancel).toHaveBeenCalled();
		expect(editor.getText()).toBe("bc");
	});
	it("autocomplete Escape is forwarded first without changing mode", () => {
		const editor = makeEditor();
		const showing = vi.spyOn(editor, "isShowingAutocomplete").mockReturnValue(true);
		editor.handleInput("\x1b");
		expect(editor.vimMode).toBe("insert");
		showing.mockRestore();
		editor.handleInput("\x1b");
		expect(editor.vimMode).toBe("normal");
	});
});
