import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import editorExtension, {
	BADGE_MIN_KEEP,
	NamedSessionEditor,
	COMBO_LEADERS,
	CURSOR_RESET_SEQUENCE,
	CURSOR_SHAPE_BEAM,
	CURSOR_SHAPE_BLOCK,
	CURSOR_SHAPE_RESET,
	NORMAL_COMBOS,
	NORMAL_KEYS,
	renderBottomBorderWithMode,
	renderTopBorderWithBadge,
	sanitizeSessionName,
	stripCursorInverse,
} from "../extensions/editor.js";

const identity = (text: string) => text;
const native = (width: number) => "─".repeat(width);

function setup(name: string | undefined = "my-session") {
	return new NamedSessionEditor(
		{} as never,
		{ borderColor: identity, selectList: {} as never },
		{ matches: () => false } as never,
		() => name,
	);
}

describe("session-name badge", () => {
	it("sanitizes names and falls back to the native border", () => {
		expect(sanitizeSessionName(undefined)).toBeUndefined();
		expect(sanitizeSessionName("  \r\na  b  ")).toBe("a  b");
		expect(renderTopBorderWithBadge(native(30), undefined, 30, identity)).toBe(native(30));
		expect(renderTopBorderWithBadge(native(10), "my-session", 10, identity)).toBe(native(10));
		expect(BADGE_MIN_KEEP).toBe(8);
	});
	it("renders the badge with truncation and padding", () => {
		expect(stripTerminalSequences(renderTopBorderWithBadge(native(30), "my-session", 30, identity)))
			.toBe(`${"─".repeat(16)} my-session ──`);
		expect(stripTerminalSequences(renderTopBorderWithBadge(native(30), "very-long-session-name-here", 30, identity)))
			.toBe(`${"─".repeat(8)} very-long-session… ──`);
	});
	it("embeds working status and preserves the native unnamed border", () => {
		expect(setup().embedWorkingStatus).toBe(true);
		const editor = setup("") as unknown as { renderTopBorder(width: number, hidden: number): string };
		expect(editor.renderTopBorder(30, 0)).toBe(native(30));
	});
});

describe("modal input routing", () => {
	it("exposes only the supported key set", () => {
		expect(Object.keys(NORMAL_KEYS).sort()).toEqual(
			["h", "j", "k", "l", "0", "^", "$", "w", "b", "e", "x", "s", "D", "C", "i", "a", "I", "A", "o", "O"].sort(),
		);
		expect(Object.keys(NORMAL_COMBOS).sort()).toEqual(["dd", "dw", "d$", "cc", "cw", "c$"].sort());
		expect(COMBO_LEADERS).toEqual(new Set(["d", "c"]));
	});
	it("starts in insert mode, supports escape and insert entry", () => {
		const editor = setup();
		expect(editor.vimMode).toBe("insert");
		editor.handleInput("\x1b");
		expect(editor.vimMode).toBe("normal");
		editor.handleInput("i");
		expect(editor.vimMode).toBe("insert");
	});
	it("passes insert input and unowned normal controls to Pi", () => {
		const superInput = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});
		try {
			const editor = setup();
			editor.handleInput("h");
			editor.handleInput("\x1b");
			editor.handleInput("z"); // unsupported printable keys do not enter text
			editor.handleInput("\x03"); // ctrl+c retains its host meaning
			editor.handleInput("\x1b"); // normal Escape delegates to app
			expect(superInput.mock.calls.map(([key]) => key)).toEqual(["h", "\x03", "\x1b"]);
		} finally {
			superInput.mockRestore();
		}
	});
	it("renders the mode and pending command on the bottom border", () => {
		const render = vi.spyOn(CustomEditor.prototype, "render").mockImplementation(() => [native(30), native(30)]);
		try {
			const editor = setup();
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("── INSERT ──" + "─".repeat(18));
			editor.handleInput("\x1b");
			editor.handleInput("3");
			editor.handleInput("d");
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("── NORMAL 3d ──" + "─".repeat(15));
			editor.handleInput("\x1b");
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("── NORMAL ──" + "─".repeat(18));
		} finally {
			render.mockRestore();
		}
	});
});

describe("cursor shape and bottom border rendering", () => {
	it("strips software cursor inverse in insert mode and preserves text", () => {
		const lineWithChar = `hello ${CURSOR_MARKER}\x1b[7mw\x1b[0morld`;
		expect(stripCursorInverse(lineWithChar)).toBe(`hello ${CURSOR_MARKER}world`);

		const lineWithSpace = `hello world${CURSOR_MARKER}\x1b[7m \x1b[0m`;
		expect(stripCursorInverse(lineWithSpace)).toBe(`hello world${CURSOR_MARKER} `);

		const lineWithoutCursor = "hello world";
		expect(stripCursorInverse(lineWithoutCursor)).toBe(lineWithoutCursor);
	});

	it("renders bottom border with mode and pending keys on the left", () => {
		expect(stripTerminalSequences(renderBottomBorderWithMode(native(30), "insert", undefined, undefined, 30, identity)))
			.toBe("── INSERT ──" + "─".repeat(18));
		expect(stripTerminalSequences(renderBottomBorderWithMode(native(30), "normal", "d", 3, 30, identity)))
			.toBe("── NORMAL 3d ──" + "─".repeat(15));
		expect(renderBottomBorderWithMode(native(10), "insert", undefined, undefined, 10, identity))
			.toBe(native(10));
	});

	it("preserves scroll down indicators on the bottom border", () => {
		const scrollBorder = "───────── ↓ 2 more ──────────";
		expect(renderBottomBorderWithMode(scrollBorder, "normal", undefined, undefined, scrollBorder.length, identity))
			.toBe(scrollBorder);

		const wideScrollBorder = "─".repeat(25) + " ↓ 2 more " + "─".repeat(25);
		const rendered = renderBottomBorderWithMode(wideScrollBorder, "normal", undefined, undefined, wideScrollBorder.length, identity);
		expect(stripTerminalSequences(rendered)).toContain("── NORMAL ──");
		expect(stripTerminalSequences(rendered)).toContain("↓ 2 more");
	});

	it("manages hardware cursor shapes and resets on dispose", () => {
		const terminalWrite = vi.fn();
		const setShowHardwareCursor = vi.fn();
		const mockTui = { terminal: { write: terminalWrite }, setShowHardwareCursor };

		const editor = new NamedSessionEditor(
			mockTui as never,
			{ borderColor: identity, selectList: {} as never },
			{ matches: () => false } as never,
			() => "my-session",
		);

		expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
		expect(terminalWrite).toHaveBeenCalledWith(CURSOR_SHAPE_BEAM);

		// Switch to normal mode -> sends block cursor sequence
		editor.handleInput("\x1b");
		expect(terminalWrite).toHaveBeenCalledWith(CURSOR_SHAPE_BLOCK);

		// Switch back to insert mode -> sends beam cursor sequence
		editor.handleInput("i");
		expect(terminalWrite).toHaveBeenCalledWith(CURSOR_SHAPE_BEAM);

		// Dispose resets terminal cursor and forces visibility on without hiding
		editor.dispose();
		expect(terminalWrite).toHaveBeenCalledWith(CURSOR_RESET_SEQUENCE);
		expect(setShowHardwareCursor).not.toHaveBeenCalledWith(false);
	});

	it("strips software cursor inverse only in insert mode during render", () => {
		const cursorLine = `hello ${CURSOR_MARKER}\x1b[7mw\x1b[0morld`;
		const renderSpy = vi.spyOn(CustomEditor.prototype, "render").mockImplementation(() => [cursorLine, native(30)]);
		try {
			const editor = setup();
			// Insert mode: software cursor inverse is stripped
			const insertLines = editor.render(30);
			expect(insertLines[0]).toBe(`hello ${CURSOR_MARKER}world`);

			// Normal mode: software cursor inverse is retained
			editor.handleInput("\x1b");
			const normalLines = editor.render(30);
			expect(normalLines[0]).toBe(cursorLine);
		} finally {
			renderSpy.mockRestore();
		}
	});

	it("restores hardware cursor and re-emits cursor shape after external reset (e.g. /reload)", () => {
		let hardwareCursor = false;
		const terminalWrite = vi.fn();
		const setShowHardwareCursor = vi.fn((val: boolean) => {
			hardwareCursor = val;
		});
		const getShowHardwareCursor = vi.fn(() => hardwareCursor);
		const mockTui = {
			terminal: { write: terminalWrite },
			setShowHardwareCursor,
			getShowHardwareCursor,
		};

		const editor = new NamedSessionEditor(
			mockTui as never,
			{ borderColor: identity, selectList: {} as never },
			{ matches: () => false } as never,
			() => "my-session",
		);

		expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
		expect(terminalWrite).toHaveBeenCalledWith(CURSOR_SHAPE_BEAM);
		setShowHardwareCursor.mockClear();
		terminalWrite.mockClear();

		// Simulate Pi's handleReloadCommand calling applyRuntimeSettings(),
		// which resets showHardwareCursor back to false
		hardwareCursor = false;

		const cursorLine = `hello ${CURSOR_MARKER}\x1b[7mw\x1b[0morld`;
		const renderSpy = vi.spyOn(CustomEditor.prototype, "render").mockImplementation(() => [cursorLine, native(30)]);
		try {
			// First render after reload: detects false, re-enables hardware cursor and forces beam shape
			const lines = editor.render(30);
			expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
			expect(terminalWrite).toHaveBeenCalledWith(CURSOR_SHAPE_BEAM);
			// Inverse is stripped because hardware cursor is restored
			expect(lines[0]).toBe(`hello ${CURSOR_MARKER}world`);

			// Subsequent render with hardware cursor still active: no redundant setter or escape sequence
			setShowHardwareCursor.mockClear();
			terminalWrite.mockClear();
			editor.render(30);
			expect(setShowHardwareCursor).not.toHaveBeenCalled();
			expect(terminalWrite).not.toHaveBeenCalled();
		} finally {
			renderSpy.mockRestore();
		}
	});

	it("preserves software cursor inverse when hardware cursor cannot be enabled", () => {
		const mockTui = {
			terminal: { write: vi.fn() },
			setShowHardwareCursor: vi.fn(),
			getShowHardwareCursor: vi.fn(() => false),
		};

		const editor = new NamedSessionEditor(
			mockTui as never,
			{ borderColor: identity, selectList: {} as never },
			{ matches: () => false } as never,
			() => "my-session",
		);

		const cursorLine = `hello ${CURSOR_MARKER}\x1b[7mw\x1b[0morld`;
		const renderSpy = vi.spyOn(CustomEditor.prototype, "render").mockImplementation(() => [cursorLine, native(30)]);
		try {
			// Insert mode: software cursor inverse is preserved when hardware cursor remains false
			const lines = editor.render(30);
			expect(lines[0]).toBe(cursorLine);
		} finally {
			renderSpy.mockRestore();
		}
	});
});

describe("editorExtension lifecycle", () => {
	type Handler = (event: never, ctx?: never) => void;
	function setupHarness() {
		const handlers = new Map<string, Handler>();
		const pi = { registerCommand: vi.fn(), on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		}) };
		editorExtension(pi as never);
		return { handlers, pi };
	}
	it("registers lifecycle handlers and the copy command", () => {
		const { pi } = setupHarness();
		expect(pi.registerCommand).toHaveBeenCalledWith("copy-command", expect.objectContaining({ handler: expect.any(Function) }));
		for (const name of ["session_start", "session_info_changed", "session_shutdown"])
			expect(pi.on).toHaveBeenCalledWith(name, expect.any(Function));
	});
	it("installs only in TUI and defers to another custom editor", () => {
		const { handlers } = setupHarness();
		const ui = { getEditorComponent: vi.fn(() => undefined as unknown), setEditorComponent: vi.fn(), notify: vi.fn() };
		handlers.get("session_start")!(undefined as never, { mode: "rpc", ui } as never);
		expect(ui.setEditorComponent).not.toHaveBeenCalled();
		ui.getEditorComponent.mockReturnValue(() => {});
		handlers.get("session_start")!(undefined as never, { mode: "tui", ui } as never);
		expect(ui.setEditorComponent).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith("Session-name badge deferred: another custom editor is active", "info");
		ui.getEditorComponent.mockReturnValue(undefined);
		handlers.get("session_start")!(undefined as never, {
			mode: "tui", ui, sessionManager: { getSessionName: () => "my-session" },
		} as never);
		expect(ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
	});
});
