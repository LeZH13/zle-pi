import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import editorExtension, {
	BADGE_MIN_KEEP,
	NamedSessionEditor,
	renderTopBorderWithBadge,
	sanitizeSessionName,
} from "../extensions/editor.js";

const identity = (text: string) => text;
const native = (width: number) => "─".repeat(width);

describe("sanitizeSessionName", () => {
	it("hides undefined, empty, and whitespace-only names", () => {
		expect(sanitizeSessionName(undefined)).toBeUndefined();
		expect(sanitizeSessionName("")).toBeUndefined();
		expect(sanitizeSessionName("   ")).toBeUndefined();
	});
	it("trims ends and flattens newlines to a space", () => {
		expect(sanitizeSessionName("  my-session  ")).toBe("my-session");
		expect(sanitizeSessionName("a\r\nb")).toBe("a b");
	});
});

describe("renderTopBorderWithBadge", () => {
	it("returns the native border untouched for unnamed sessions", () => {
		const border = native(30);
		expect(renderTopBorderWithBadge(border, undefined, 30, identity)).toBe(border);
		expect(renderTopBorderWithBadge(border, "   ", 30, identity)).toBe(border);
	});
	it("renders the badge with two trailing dashes of padding", () => {
		const out = renderTopBorderWithBadge(native(30), "my-session", 30, identity);
		expect(stripTerminalSequences(out)).toBe(`${"─".repeat(16)} my-session ──`);
	});
	it("truncates long names with a single-char ellipsis", () => {
		const out = renderTopBorderWithBadge(native(30), "very-long-session-name-here", 30, identity);
		expect(stripTerminalSequences(out)).toBe(`${"─".repeat(8)} very-long-session… ──`);
	});
	it("yields to native when the truncated name would be a stub", () => {
		const border = native(10);
		expect(renderTopBorderWithBadge(border, "my-session", 10, identity)).toBe(border);
		expect(BADGE_MIN_KEEP).toBe(8);
	});
});

describe("NamedSessionEditor", () => {
	function setup(name: string | undefined) {
		return new NamedSessionEditor(
			{} as never,
			{ borderColor: identity, selectList: {} as never },
			{} as never,
			() => name,
		);
	}

	it("embeds working status like the default editor", () => {
		const editor = setup("my-session") as unknown as { embedWorkingStatus: boolean };
		expect(editor.embedWorkingStatus).toBe(true);
	});

	it("splices the badge over the native border", () => {
		const editor = setup("my-session") as unknown as {
			renderTopBorder(width: number, hidden: number): string;
		};
		const out = editor.renderTopBorder(30, 0);
		expect(stripTerminalSequences(out)).toBe(`${"─".repeat(16)} my-session ──`);
	});

	it("renders native when unnamed", () => {
		const editor = setup(undefined) as unknown as {
			renderTopBorder(width: number, hidden: number): string;
		};
		expect(editor.renderTopBorder(30, 0)).toBe(native(30));
	});
});

describe("editorExtension lifecycle", () => {
	type Handler = (event: never, ctx?: never) => void;

	function setupHarness() {
		const handlers = new Map<string, Handler>();
		const pi = {
			on: vi.fn((event: string, handler: Handler) => {
				handlers.set(event, handler);
				return () => {
					handlers.delete(event);
				};
			}),
		};
		editorExtension(pi as never);
		return { handlers, pi };
	}

	it("registers session lifecycle handlers", () => {
		const { pi } = setupHarness();
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_info_changed", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("installs the editor on session_start in tui mode", () => {
		const { handlers } = setupHarness();
		const ctx: any = {
			mode: "tui",
			sessionManager: { getSessionName: () => "my-session" },
			ui: {
				getEditorComponent: () => undefined,
				setEditorComponent: vi.fn(),
				notify: vi.fn(),
			},
		} as never;
		handlers.get("session_start")!(undefined as never, ctx);
		expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("defers with a notify when another custom editor is active", () => {
		const { handlers } = setupHarness();
		const other = () => undefined as never;
		const ctx: any = {
			mode: "tui",
			ui: {
				getEditorComponent: () => other,
				setEditorComponent: vi.fn(),
				notify: vi.fn(),
			},
		} as never;
		handlers.get("session_start")!(undefined as never, ctx);
		expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Session-name badge deferred: another custom editor is active",
			"info",
		);
	});

	it("skips non-tui modes", () => {
		const { handlers } = setupHarness();
		const ctx: any = {
			mode: "rpc",
			ui: { getEditorComponent: () => undefined, setEditorComponent: vi.fn() },
		} as never;
		handlers.get("session_start")!(undefined as never, ctx);
		expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
	});
});
