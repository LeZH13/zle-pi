import { describe, expect, it, vi } from "vitest";
import { NamedSessionEditor } from "../extensions/editor.js";

/**
 * Integration-style tests: no prototype mocking. The real CustomEditor ->
 * Editor chain runs with minimal fakes, so undo/redo act on genuine editor
 * state exactly like the live runtime.
 */
function makeEditor(): NamedSessionEditor {
	const tui = { requestRender: () => {}, scheduleRender: () => {}, getColorDepth: () => 4 };
	const theme = { borderColor: (s: string) => s, selectList: {}, text: (s: string) => s };
	return new NamedSessionEditor(
		tui as never,
		theme as never,
		{ matches: () => false } as never,
		() => "my-session",
	);
}

const state = (editor: NamedSessionEditor) =>
	(editor as unknown as { state: { lines: string[] } }).state;

function type(editor: NamedSessionEditor, text: string): void {
	for (const ch of text) editor.handleInput(ch);
}

describe("vim undo/redo (u / ctrl+r)", () => {
	it("u undoes a mapped deletion, ctrl+r redoes it", () => {
		const editor = makeEditor();
		type(editor, "hello world");
		editor.handleInput("\x1b"); // normal, cursor rests on the last char like vim
		editor.handleInput("0"); // word start
		editor.handleInput("d");
		editor.handleInput("w"); // delete "hello " (coalesced)
		expect(state(editor).lines[0]).toBe("world");
		editor.handleInput("u");
		expect(state(editor).lines[0]).toBe("hello world");
		editor.handleInput("\x12"); // ctrl+r
		expect(state(editor).lines[0]).toBe("world");
	});

	it("one u undoes a whole linewise dd", () => {
		const editor = makeEditor();
		type(editor, "first");
		editor.handleInput("\n");
		type(editor, "second");
		editor.handleInput("\x1b"); // normal
		editor.handleInput("d");
		editor.handleInput("d");
		expect(state(editor).lines).toEqual(["first"]);
		editor.handleInput("u"); // single press
		expect(state(editor).lines).toEqual(["first", "second"]);
		editor.handleInput("\x12");
		expect(state(editor).lines).toEqual(["first"]);
	});

	it("redo can itself be undone and redone", () => {
		const editor = makeEditor();
		type(editor, "abc");
		editor.handleInput("\x1b");
		editor.handleInput("x");
		editor.handleInput("u");
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("ab");
		editor.handleInput("u");
		expect(editor.getText()).toBe("abc");
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("ab");
	});

	it("accepts Kitty CSI-u ctrl+r as redo", () => {
		const editor = makeEditor();
		type(editor, "abc");
		editor.handleInput("\x1b");
		editor.handleInput("x");
		editor.handleInput("u");
		editor.handleInput("\x1b[114;5u");
		expect(editor.getText()).toBe("ab");
	});

	it("typed text after undo invalidates redo", () => {
		const editor = makeEditor();
		type(editor, "abc");
		editor.handleInput("\x1b");
		editor.handleInput("x"); // delete 'c'
		expect(state(editor).lines[0]).toBe("ab");
		editor.handleInput("u");
		expect(state(editor).lines[0]).toBe("abc");
		editor.handleInput("i"); // insert
		type(editor, "Z");
		editor.handleInput("\x1b"); // new change invalidates redo
		editor.handleInput("\x12");
		expect(state(editor).lines[0]).toBe("abZc");
	});

	it("u chains through multiple changes", () => {
		const editor = makeEditor();
		type(editor, "abcdef");
		editor.handleInput("\x1b");
		editor.handleInput("x"); // delete 'f'
		editor.handleInput("x"); // delete 'e'
		expect(state(editor).lines[0]).toBe("abcd");
		editor.handleInput("u");
		expect(state(editor).lines[0]).toBe("abcde");
		editor.handleInput("u");
		expect(state(editor).lines[0]).toBe("abcdef");
	});

	it("motions do not consume undo steps", () => {
		const editor = makeEditor();
		type(editor, "alpha beta");
		editor.handleInput("\x1b");
		editor.handleInput("0"); // word start
		editor.handleInput("d");
		editor.handleInput("w"); // delete "alpha "
		expect(state(editor).lines[0]).toBe("beta");
		editor.handleInput("b"); // motion
		editor.handleInput("w"); // motion
		editor.handleInput("u"); // single press undoes the deletion
		expect(state(editor).lines[0]).toBe("alpha beta");
	});

	it("counts repeat undo and redo (3u / 2ctrl+r)", () => {
		const editor = makeEditor();
		type(editor, "abcdef");
		editor.handleInput("\x1b");
		editor.handleInput("x");
		editor.handleInput("x");
		editor.handleInput("x");
		expect(state(editor).lines[0]).toBe("abc");
		editor.handleInput("3");
		editor.handleInput("u");
		expect(state(editor).lines[0]).toBe("abcdef");
		editor.handleInput("2");
		editor.handleInput("\x12");
		expect(state(editor).lines[0]).toBe("abcd");
	});

	it("insert-mode typing retains Pi's native word/space undo grouping", () => {
		const editor = makeEditor();
		type(editor, "hello world");
		editor.handleInput("\x1b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("hello");
	});

	it("u with empty history is a no-op", () => {
		const editor = makeEditor();
		editor.handleInput("\x1b");
		expect(() => editor.handleInput("u")).not.toThrow();
		expect(state(editor).lines[0]).toBe("");
	});

	it("still exposes the pi-native undo binding alongside u", () => {
		// ctrl+- goes through CustomEditor (app keybindings) -> editor.undo()
		const editor = makeEditor();
		const spy = vi.spyOn(editor as unknown as { undo(): void }, "undo");
		type(editor, "abc");
		editor.handleInput("\x1b");
		editor.handleInput("\x1f"); // ctrl+- produces 0x1f
		expect(spy).toHaveBeenCalled();
	});
});
