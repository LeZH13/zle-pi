import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import editorExtension, {
	BADGE_MIN_KEEP,
	NamedSessionEditor,
	COMBO_LEADERS,
	NORMAL_COMBOS,
	NORMAL_KEYS,
	renderTopBorderWithBadge,
	sanitizeSessionName,
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
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("─".repeat(20) + " INSERT ──");
			editor.handleInput("\x1b");
			editor.handleInput("3");
			editor.handleInput("d");
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("─".repeat(17) + " NORMAL 3d ──");
			editor.handleInput("\x1b");
			expect(stripTerminalSequences(editor.render(30)[1]!)).toBe("─".repeat(20) + " NORMAL ──");
		} finally {
			render.mockRestore();
		}
	});
});

describe("editorExtension lifecycle", () => {
	type Handler = (event: never, ctx?: never) => void;
	function setupHarness() {
		const handlers = new Map<string, Handler>();
		const pi = { on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		}) };
		editorExtension(pi as never);
		return { handlers, pi };
	}
	it("registers lifecycle handlers", () => {
		const { pi } = setupHarness();
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
