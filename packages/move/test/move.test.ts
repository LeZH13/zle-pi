import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import moveExtension from "../extensions/index.js";
import { createNewSessionFile } from "../extensions/utils.js";

describe("move extension", () => {
	const originalCwd = process.cwd();
	let tempDir: string;
	let registeredCommands: Map<string, any>;
	let registeredListeners: Map<string, any>;
	let mockPi: ExtensionAPI;

	beforeEach(() => {
		process.chdir(originalCwd);
		tempDir = join(tmpdir(), `pi-move-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		registeredCommands = new Map();
		registeredListeners = new Map();

		mockPi = {
			registerCommand: vi.fn((name, options) => {
				registeredCommands.set(name, options);
			}),
			on: vi.fn((event, handler) => {
				registeredListeners.set(event, handler);
			}),
		} as unknown as ExtensionAPI;

		moveExtension(mockPi);
	});

	afterEach(() => {
		try {
			process.chdir(originalCwd);
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("registers the /move command and session_start listener", () => {
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"move",
			expect.objectContaining({
				description: "Switch working directory and session",
			}),
		);
		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});

	it("updates currentCwd on session_start event and returns completions", async () => {
		const command = registeredCommands.get("move");
		const sessionStartHandler = registeredListeners.get("session_start");

		const projectA = join(tempDir, "project-a");
		mkdirSync(join(projectA, "sub-folder"), { recursive: true });

		sessionStartHandler({}, { cwd: projectA });

		const completions = await command.getArgumentCompletions("");
		expect(completions).not.toBeNull();
		const values = completions.map((c: any) => c.value);
		expect(values).toContain("sub-folder/");
	});

	it("provides recent directory completions from session history", async () => {
		const command = registeredCommands.get("move");
		const recentProject = join(tempDir, "recent-work");
		mkdirSync(recentProject, { recursive: true });

		vi.spyOn(SessionManager, "listAll").mockResolvedValueOnce([
			{
				path: "/sessions/s1.jsonl",
				id: "s1",
				cwd: recentProject,
				created: new Date(),
				modified: new Date(),
				messageCount: 2,
			},
		] as any);

		const completions = await command.getArgumentCompletions("recent");
		expect(completions).not.toBeNull();
		const values = completions.map((c: any) => c.value);
		expect(values).toContain(`${recentProject}/`);
	});

	it("notifies an error if UI is not available", async () => {
		const command = registeredCommands.get("move");
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: false,
			ui: { notify: notifyMock },
			cwd: tempDir,
		};

		await command.handler("some-dir", mockCtx);
		expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("requires an interactive UI"), "error");
	});

	it("requires a destination path argument", async () => {
		const command = registeredCommands.get("move");
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { notify: notifyMock },
			cwd: tempDir,
		};

		await command.handler("", mockCtx);
		expect(notifyMock).toHaveBeenCalledWith(
			"A destination path is required. Usage: /move <path>",
			"error",
		);
	});

	it("rejects an empty quoted destination path", async () => {
		const command = registeredCommands.get("move");
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { notify: notifyMock },
			cwd: tempDir,
		};

		await command.handler('"   "', mockCtx);
		expect(notifyMock).toHaveBeenCalledWith(
			"A destination path is required. Usage: /move <path>",
			"error",
		);
	});

	it("notifies info if target is already current working directory", async () => {
		const command = registeredCommands.get("move");
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { notify: notifyMock },
			cwd: tempDir,
		};

		await command.handler(tempDir, mockCtx);
		expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("Already in"), "info");
	});

	it("notifies error if target is a file instead of a directory", async () => {
		const command = registeredCommands.get("move");
		const filePath = join(tempDir, "file.txt");
		writeFileSync(filePath, "content");
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { notify: notifyMock },
			cwd: tempDir,
		};

		await command.handler(filePath, mockCtx);
		expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("Target is not a directory"), "error");
	});

	it("prompts to create directory if target does not exist, and creates it if confirmed", async () => {
		const command = registeredCommands.get("move");
		const nonExistentDir = join(tempDir, "new-project");
		const confirmMock = vi.fn().mockResolvedValue(true);
		const switchSessionMock = vi.fn().mockResolvedValue({ cancelled: false });
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { confirm: confirmMock, notify: notifyMock },
			cwd: tempDir,
			switchSession: switchSessionMock,
		};

		await command.handler(nonExistentDir, mockCtx);
		expect(confirmMock).toHaveBeenCalledWith("Directory does not exist", expect.any(String));
		expect(existsSync(nonExistentDir)).toBe(true);
		expect(switchSessionMock).toHaveBeenCalledWith(expect.stringMatching(/\.jsonl$/), expect.any(Object));
	});

	it("automatically starts a new session if target directory has no existing sessions", async () => {
		const command = registeredCommands.get("move");
		const targetDir = join(tempDir, "empty-target");
		mkdirSync(targetDir, { recursive: true });

		const switchSessionMock = vi.fn().mockImplementation(async (sessionFile, options) => {
			if (options?.withSession) {
				const replacementCtx = { ui: { notify: vi.fn() } };
				await options.withSession(replacementCtx);
			}
			return { cancelled: false };
		});
		const selectMock = vi.fn();
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock },
			cwd: tempDir,
			switchSession: switchSessionMock,
		};

		await command.handler(targetDir, mockCtx);
		expect(selectMock).not.toHaveBeenCalled();
		expect(switchSessionMock).toHaveBeenCalledWith(expect.stringMatching(/\.jsonl$/), expect.any(Object));
	});

	it("presents existing session options and switches to selected existing session", async () => {
		const command = registeredCommands.get("move");
		const targetDir = join(tempDir, "target-with-sessions");
		mkdirSync(targetDir, { recursive: true });

		// Create an existing session file in targetDir
		const existingSessionFile = createNewSessionFile(targetDir);

		// Spy on SessionManager.list to return this session
		const mockSessionList = [
			{
				path: existingSessionFile,
				id: "sess-12345",
				cwd: targetDir,
				name: "Build login feature",
				firstMessage: "Start login",
				created: new Date(),
				modified: new Date(),
				messageCount: 3,
				allMessagesText: "Start login",
			},
		];
		vi.spyOn(SessionManager, "list").mockResolvedValueOnce(mockSessionList as any);

		const selectMock = vi.fn().mockImplementation(async (_title, options: string[]) => {
			// Select the existing session (second option after new session)
			return options[1];
		});
		const switchSessionMock = vi.fn().mockResolvedValue({ cancelled: false });
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock },
			cwd: tempDir,
			switchSession: switchSessionMock,
		};

		await command.handler(targetDir, mockCtx);
		expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("Select session"), expect.any(Array));
		expect(switchSessionMock).toHaveBeenCalledWith(existingSessionFile, expect.any(Object));
	});

	it("creates a fresh new session when user selects [+ Start a new session]", async () => {
		const command = registeredCommands.get("move");
		const targetDir = join(tempDir, "target-with-sessions-2");
		mkdirSync(targetDir, { recursive: true });

		const mockSessionList = [
			{
				path: "/fake/path/session.jsonl",
				id: "sess-999",
				cwd: targetDir,
				name: "Old session",
				firstMessage: "Old",
				created: new Date(),
				modified: new Date(),
				messageCount: 1,
				allMessagesText: "Old",
			},
		];
		vi.spyOn(SessionManager, "list").mockResolvedValueOnce(mockSessionList as any);

		const selectMock = vi.fn().mockImplementation(async (_title, options: string[]) => {
			// Select first option: [+] Start a new session
			return options[0];
		});
		const switchSessionMock = vi.fn().mockResolvedValue({ cancelled: false });
		const notifyMock = vi.fn();

		const mockCtx = {
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock },
			cwd: tempDir,
			switchSession: switchSessionMock,
		};

		await command.handler(targetDir, mockCtx);
		expect(selectMock).toHaveBeenCalled();
		expect(switchSessionMock).toHaveBeenCalledWith(expect.stringMatching(/\.jsonl$/), expect.any(Object));
		// Ensure it didn't use the existing session path
		expect(switchSessionMock).not.toHaveBeenCalledWith("/fake/path/session.jsonl", expect.any(Object));
	});
});
