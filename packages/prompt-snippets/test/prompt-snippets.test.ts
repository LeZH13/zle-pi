import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptSnippetsExtension } from "../extensions/prompt-snippets.js";

describe("prompt snippets extension", () => {
	let tempDir: string;
	let projectDir: string;
	let bundledDir: string;
	let agentDir: string;
	let registeredListeners: Map<string, Function>;
	let registeredShortcuts: Map<string, any>;
	let registeredCommands: Map<string, any>;
	let mockPi: ExtensionAPI;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		bundledDir = join(tempDir, "bundled");
		agentDir = join(tempDir, "agent");

		mkdirSync(projectDir, { recursive: true });
		mkdirSync(bundledDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		registeredListeners = new Map();
		registeredShortcuts = new Map();
		registeredCommands = new Map();

		mockPi = {
			on: vi.fn((event: string, handler: Function) => {
				registeredListeners.set(event, handler);
			}),
			registerShortcut: vi.fn((shortcut: string, options: any) => {
				registeredShortcuts.set(shortcut, options);
			}),
			registerCommand: vi.fn((name: string, options: any) => {
				registeredCommands.set(name, options);
			}),
		} as unknown as ExtensionAPI;
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("registers session_start, session_shutdown, input, alt+s shortcut and snippets command", () => {
		const extension = createPromptSnippetsExtension({ bundledDir, agentDir });
		extension(mockPi);

		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("input", expect.any(Function));
		expect(mockPi.registerShortcut).toHaveBeenCalledWith("alt+s", {
			description: "Toggle prompt snippets",
			handler: expect.any(Function),
		});
		expect(mockPi.registerCommand).toHaveBeenCalledWith("snippets", {
			description: "Open the prompt snippet toggle menu",
			handler: expect.any(Function),
		});
	});

	it("leaves message unchanged when no snippets are active", async () => {
		const extension = createPromptSnippetsExtension({ bundledDir, agentDir });
		extension(mockPi);

		const inputHandler = registeredListeners.get("input");
		const result = await inputHandler!(
			{ text: "My message" },
			{ cwd: projectDir, hasUI: true, mode: "tui" } as ExtensionContext,
		);

		expect(result).toBeUndefined();
	});

	it("transforms message when snippets are active and clears selection after send", async () => {
		const extension = createPromptSnippetsExtension({ bundledDir, agentDir });
		extension(mockPi);

		const projectSnippetsDir = join(projectDir, ".pi", "snippets");
		mkdirSync(projectSnippetsDir, { recursive: true });
		writeFileSync(
			join(projectSnippetsDir, "prep.md"),
			`---
name: Prepend Rule
placement: prepend
order: 10
---
[PREPEND CONTENT]`,
		);
		writeFileSync(
			join(projectSnippetsDir, "app.md"),
			`---
name: Append Rule
placement: append
order: 10
---
[APPEND CONTENT]`,
		);

		const setWidgetMock = vi.fn();
		const customMock = vi.fn(async (callback: any) => {
			const fakeTui = {
				terminal: { rows: 24 },
				requestRender: vi.fn(),
			};
			const fakeTheme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			let confirmed = false;
			const component = callback(fakeTui, fakeTheme, {}, (res: boolean) => {
				confirmed = res;
			});

			// Toggle first item (prep.md)
			component.handleInput(" ");
			// Down (move to app.md)
			component.handleInput("\x1b[B");
			// Toggle second item (app.md)
			component.handleInput(" ");
			// Enter (confirm)
			component.handleInput("\r");
			return confirmed;
		});

		const mockCtx = {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: {
				custom: customMock,
				setWidget: setWidgetMock,
				notify: vi.fn(),
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		} as unknown as ExtensionContext;

		// 1. Session start
		const sessionStartHandler = registeredListeners.get("session_start");
		sessionStartHandler!({}, mockCtx);

		// 2. Open snippets menu via command
		const command = registeredCommands.get("snippets");
		await command.handler("", mockCtx);

		// 3. User sends a message -> input event fires
		const inputHandler = registeredListeners.get("input");
		const transformResult = await inputHandler!({ text: "Hello AI" }, mockCtx);

		expect(transformResult).toBeDefined();
		expect(transformResult.action).toBe("transform");
		expect(transformResult.text).toBe("[PREPEND CONTENT]\n\nHello AI\n\n[APPEND CONTENT]");

		// 4. Next message should not transform because snippets auto-reset after each send
		const secondResult = await inputHandler!({ text: "Next message" }, mockCtx);
		expect(secondResult).toBeUndefined();
	});

	it("supports custom keybindings (like Emacs ctrl+n and ctrl+p) in menu and preview", async () => {
		const extension = createPromptSnippetsExtension({ bundledDir, agentDir });
		extension(mockPi);

		const projectSnippetsDir = join(projectDir, ".pi", "snippets");
		mkdirSync(projectSnippetsDir, { recursive: true });
		writeFileSync(
			join(projectSnippetsDir, "item1.md"),
			`---\nname: Item 1\nplacement: prepend\norder: 1\n---\nItem 1 content`,
		);
		writeFileSync(
			join(projectSnippetsDir, "item2.md"),
			`---\nname: Item 2\nplacement: prepend\norder: 2\n---\nItem 2 content`,
		);

		const mockKeybindings = {
			matches: vi.fn((data: string, id: string) => {
				if (id === "tui.select.up") return data === "\x10" || data === "\x1b[A"; // ctrl+p or up
				if (id === "tui.select.down") return data === "\x0e" || data === "\x1b[B"; // ctrl+n or down
				if (id === "tui.select.confirm") return data === "\r" || data === "\n";
				if (id === "tui.select.cancel") return data === "\x07" || data === "\x1b"; // ctrl+g or escape
				return false;
			}),
		};

		let renderOutput: string[] = [];
		const customMock = vi.fn(async (callback: any) => {
			const fakeTui = {
				terminal: { rows: 24 },
				requestRender: vi.fn(() => {
					renderOutput = component.render(80);
				}),
			};
			const fakeTheme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			let confirmed = false;
			const component = callback(fakeTui, fakeTheme, mockKeybindings, (res: boolean) => {
				confirmed = res;
			});

			renderOutput = component.render(80);

			// Navigate down with Ctrl+N (0x0E) to item 2
			component.handleInput("\x0e");
			// Toggle item 2
			component.handleInput(" ");

			// Open preview with Tab
			component.handleInput("\t");
			expect(renderOutput.join("\n")).toContain("Preview: Item 2");

			// Scroll down preview with Ctrl+N
			component.handleInput("\x0e");

			// Exit preview with Ctrl+G (0x07)
			component.handleInput("\x07");
			expect(renderOutput.join("\n")).toContain("Prompt snippets");

			// Navigate back up with Ctrl+P (0x10) to item 1
			component.handleInput("\x10");
			// Toggle item 1
			component.handleInput(" ");

			// Confirm with Enter
			component.handleInput("\r");
			return confirmed;
		});

		const setWidgetMock = vi.fn();
		const mockCtx = {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: {
				custom: customMock,
				setWidget: setWidgetMock,
				notify: vi.fn(),
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		} as unknown as ExtensionContext;

		const command = registeredCommands.get("snippets");
		await command.handler("", mockCtx);

		const inputHandler = registeredListeners.get("input");
		const transformResult = await inputHandler!({ text: "Test prompt" }, mockCtx);

		expect(transformResult).toBeDefined();
		expect(transformResult.text).toBe("Item 1 content\n\nItem 2 content\n\nTest prompt");
	});

	it("cleans up widgets and state on session_shutdown", () => {
		const extension = createPromptSnippetsExtension({ bundledDir, agentDir });
		extension(mockPi);

		const setWidgetMock = vi.fn();
		const mockCtx = {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			ui: {
				setWidget: setWidgetMock,
			},
		} as unknown as ExtensionContext;

		const shutdownHandler = registeredListeners.get("session_shutdown");
		shutdownHandler!({}, mockCtx);

		expect(setWidgetMock).toHaveBeenCalledWith("prompt-snippets", undefined);
	});
});
