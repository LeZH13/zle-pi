import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import headerExtension, {
	ASCII_ART,
	buildHeaderLines,
	LOGO_COLOR_ANSI,
} from "../extensions/header.js";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

const mockDefinitions = {
	"app.interrupt": { defaultKeys: "escape", description: "to interrupt" },
	"app.clear": { defaultKeys: "ctrl+c", description: "to clear" },
	"app.exit": { defaultKeys: "ctrl+d", description: "to exit (empty)" },
	"app.suspend": { defaultKeys: "ctrl+z", description: "to suspend" },
	"tui.editor.deleteToLineEnd": { defaultKeys: "ctrl+k", description: "to delete to end" },
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "to cycle thinking level" },
	"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "cycle to next model" },
	"app.model.cycleBackward": { defaultKeys: "shift+ctrl+p", description: "cycle to previous model" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "to select model" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "to expand tools" },
	"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "to expand thinking" },
	"app.editor.external": { defaultKeys: "ctrl+g", description: "for external editor" },
	"app.message.followUp": { defaultKeys: "alt+enter", description: "to queue follow-up" },
	"app.message.dequeue": { defaultKeys: "alt+up", description: "to edit all queued messages" },
	"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "to paste files on macOS, images, or text" },
};

const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

describe("header extension", () => {
	let handlers: Map<string, Handler>;
	let commands: Map<string, any>;

	beforeEach(() => {
		handlers = new Map();
		commands = new Map();

		setKeybindings(new KeybindingsManager(mockDefinitions as any));

		headerExtension({
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
		} as unknown as ExtensionAPI);
	});

	it("registers session_start event and builtin-header command", () => {
		expect(handlers.has("session_start")).toBe(true);
		expect(commands.has("builtin-header")).toBe(true);
	});

	it("does not set header if mode is not tui or hasUI is false", async () => {
		const setHeader = vi.fn();

		const startHandler = handlers.get("session_start")!;
		await startHandler({}, { mode: "json", hasUI: true, ui: { setHeader } } as unknown as ExtensionContext);
		expect(setHeader).not.toHaveBeenCalled();

		await startHandler({}, { mode: "tui", hasUI: false, ui: { setHeader } } as unknown as ExtensionContext);
		expect(setHeader).not.toHaveBeenCalled();
	});

	it("sets header component on session_start in tui mode", async () => {
		let capturedFactory: any;
		const setHeader = vi.fn((factory) => {
			capturedFactory = factory;
		});

		const startHandler = handlers.get("session_start")!;
		await startHandler({}, {
			mode: "tui",
			hasUI: true,
			ui: {
				setHeader,
				getToolsExpanded: () => false,
			},
		} as unknown as ExtensionContext);

		expect(setHeader).toHaveBeenCalledTimes(1);
		expect(capturedFactory).toBeDefined();

		const headerComponent = capturedFactory({}, mockTheme);
		expect(typeof headerComponent.render).toBe("function");
		expect(typeof headerComponent.setExpanded).toBe("function");
		expect(typeof headerComponent.invalidate).toBe("function");

		// Initial render in compact mode
		const compactLines = headerComponent.render(120);
		expect(compactLines.length).toBe(11); // leading empty line + 10 rows

		// Toggle expanded
		headerComponent.setExpanded(true);
		const expandedLines = headerComponent.render(120);
		expect(expandedLines.length).toBeGreaterThan(11);
	});

	it("restores built-in header with builtin-header command", async () => {
		const setHeader = vi.fn();
		const notify = vi.fn();

		const cmd = commands.get("builtin-header")!;
		await cmd.handler([], {
			hasUI: true,
			ui: { setHeader, notify },
		} as unknown as ExtensionCommandContext);

		expect(setHeader).toHaveBeenCalledWith(undefined);
		expect(notify).toHaveBeenCalledWith("Built-in header restored", "info");
	});

	describe("buildHeaderLines", () => {
		it("renders compact mode with text alongside all 10 ASCII art lines", () => {
			const lines = buildHeaderLines(mockTheme, false, 120);
			// 1 leading blank line + 10 rows matching ASCII art
			expect(lines.length).toBe(11);

			// First content line contains styled logo and title
			const firstLine = lines[1];
			expect(firstLine).toContain(LOGO_COLOR_ANSI);
			expect(stripTerminalSequences(firstLine)).toContain("pi v");

			// Bottom content line contains onboarding guidance
			const lastLine = lines[10];
			expect(stripTerminalSequences(lastLine)).toContain("Ask it how to use or extend Pi.");
		});

		it("renders expanded mode in 2 columns when width >= 115", () => {
			const lines = buildHeaderLines(mockTheme, true, 120);
			expect(lines.length).toBeGreaterThan(10);
			// Should contain key shortcuts
			const plainText = lines.map(l => stripTerminalSequences(l)).join("\n");
			expect(plainText).toContain("commands");
			expect(plainText).toContain("to interrupt");
		});

		it("renders expanded mode in single column when width is between 85 and 114", () => {
			const lines = buildHeaderLines(mockTheme, true, 95);
			expect(lines.length).toBeGreaterThan(10);
			const plainText = lines.map(l => stripTerminalSequences(l)).join("\n");
			expect(plainText).toContain("to interrupt");
		});

		it("falls back to stacked layout when terminal width is < 85", () => {
			const compactLines = buildHeaderLines(mockTheme, false, 70);
			const plain = compactLines.map(l => stripTerminalSequences(l)).join("\n");
			expect(plain).toContain("Press");
			expect(plain).toContain("to show full startup help.");
		});

		it("reflects customized user keybindings dynamically", () => {
			// Customize user bindings
			setKeybindings(new KeybindingsManager(mockDefinitions as any, {
				"app.interrupt": ["escape", "ctrl+g"],
				"app.model.cycleForward": "alt+p",
				"app.model.cycleBackward": "alt+n",
				"app.editor.external": "alt+e",
			} as any));

			const lines = buildHeaderLines(mockTheme, true, 120);
			const plainText = lines.map(l => stripTerminalSequences(l)).join("\n");

			// Should reflect custom bindings
			expect(plainText).toContain("escape/ctrl+g to interrupt");
			expect(plainText).toContain("to cycle models");
			if (process.platform === "darwin") {
				expect(plainText).toContain("option+p/option+n to cycle models");
				expect(plainText).toContain("option+e for external editor");
			} else {
				expect(plainText).toContain("alt+p/alt+n to cycle models");
				expect(plainText).toContain("alt+e for external editor");
			}
		});

		it("gracefully omits unbound actions", () => {
			setKeybindings(new KeybindingsManager(mockDefinitions as any, {
				"app.suspend": [],
			} as any));

			const lines = buildHeaderLines(mockTheme, true, 120);
			const plainText = lines.map(l => stripTerminalSequences(l)).join("\n");
			expect(plainText).not.toContain("to suspend");
		});
	});
});
