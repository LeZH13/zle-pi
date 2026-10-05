import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WIDGET_KEY } from "../extensions/overlay.js";
import { getSessionEnabled, setSessionEnabled } from "../extensions/store.js";
import type { TaskDetails } from "../extensions/tasks.js";
import { setup } from "./harness.js";

function prefsFile(h: ReturnType<typeof setup>): string {
	return readFileSync(join(h.prefsDir, "pi-todo", "config.json"), "utf8");
}

describe("/todos toggle (bare command)", () => {
	it("defaults new sessions to off; toggling enables and re-toggling disables", async () => {
		const h = setup({ activeTools: ["read"] });
		await h.start();
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(false);
		// New-session default off: the tool is not activated even if declared.
		expect(h.activeTools()).toEqual(["read"]);

		await h.command("");
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(true);
		expect(h.activeTools()).toEqual(["read", "todo"]);
		expect(h.notify).toHaveBeenLastCalledWith("Todo tracking enabled for this session", "info");

		await h.command("");
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(false);
		expect(h.activeTools()).toEqual(["read"]);
		expect(h.notify).toHaveBeenLastCalledWith(
			"Todo tracking disabled — tasks are preserved (/todos to re-enable)",
			"info",
		);
	});

	it("records the toggle on the branch and never launches an agent turn", async () => {
		const h = setup();
		await h.start();
		await h.command("");
		const entries = h.manager
			.getBranch()
			.filter((e: any) => e.type === "custom" && e.customType === "zle-todo:enabled")
			.map((e: any) => e.data);
		expect(entries).toEqual([{ enabled: true }]);
		expect(h.sendUserMessage).not.toHaveBeenCalled();

		await h.command("");
		expect(
			h.manager
				.getBranch()
				.filter((e: any) => e.type === "custom" && e.customType === "zle-todo:enabled")
				.map((e: any) => e.data)
				.at(-1),
		).toEqual({ enabled: false });
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("enabling shows the overlay and the tool executes; disabling hides it and guards execute", async () => {
		const h = setup({ activeTools: ["todo", "read"] });
		await h.start();
		await h.command("");
		await h.runTodo({ action: "create", subject: "First" });
		expect(h.renderWidget(80)).toHaveLength(2);

		await h.command("");
		expect(h.activeTools()).toEqual(["read"]);
		expect(h.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
		await expect(h.execute({ action: "create", subject: "Blocked" })).rejects.toThrow(/run \/todos to enable/);

		// Re-enabling makes the preserved tasks usable again.
		await h.command("");
		const details = await h.execute({ action: "list", includeDeleted: false });
		expect((details.details as TaskDetails).tasks).toHaveLength(1);
	});

	it("commands operate on the ctx session, not the foreground pointer", async () => {
		const h = setup();
		await h.start();
		const foreground = h.manager.getSessionId();
		// Toggle from a different sid must not touch the foreground session.
		setSessionEnabled("child-session", false);
		(h.ctx as any).sessionManager = { getSessionId: () => "child-session", getBranch: () => [] };
		await h.command("");
		expect(getSessionEnabled("child-session")).toBe(true);
		expect(getSessionEnabled(foreground)).toBe(false);
		// The foreground overlay is untouched by another session's toggle.
		expect(h.setWidget).not.toHaveBeenCalled();
	});
});

describe("/todos status", () => {
	it("reports the empty state and tracking status", async () => {
		const h = setup();
		await h.start();
		await h.command("status");
		expect(h.notify).toHaveBeenCalledWith(
			expect.stringContaining("Todo tracking: off · view: collapsed\nNo todos yet."),
			"info",
		);
	});

	it("lists tasks grouped by status", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		await h.runTodo({ action: "update", id: 1, status: "in_progress", activeForm: "working" });
		await h.runTodo({ action: "create", subject: "Second" });
		h.notify.mockClear();

		await h.command("status");
		const text = h.notify.mock.calls[0][0] as string;
		expect(text).toContain("Todo tracking: on · view: collapsed");
		expect(text).toContain("1 in progress · 1 pending");
		expect(text).toContain("── Pending ──\n  ○ #2 Second");
		expect(text).toContain("── In Progress ──\n  ◐ #1 First (working)");
		expect(text).not.toContain("── Completed ──");
	});

	it("reports preserved tasks while tracking is off", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		await h.disable();
		h.notify.mockClear();

		await h.command("status");
		const text = h.notify.mock.calls[0][0] as string;
		expect(text).toContain("Todo tracking: off · view: collapsed");
		expect(text).toContain("○ #1 First");
	});
});

describe("/todos collapse|expand|view", () => {
	it("collapse/expand set the view and persist the global preference across starts", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		await h.command("expand");
		expect(h.renderWidget(80)[0]).toBe("▾ Todos (0/1)");
		expect(prefsFile(h)).toContain('"collapsed": false');

		// A fresh process (new harness on the same prefs dir) starts expanded.
		const next = setup({ prefsDir: h.prefsDir });
		await next.enable();
		await next.runTodo({ action: "create", subject: "First" });
		expect(next.renderWidget(80)[0]).toBe("▾ Todos (0/1)");
	});

	it("view toggles collapse/expand in both directions and persists", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });

		await h.command("view");
		expect(h.notify).toHaveBeenLastCalledWith("Todos expanded", "info");
		expect(h.renderWidget(80)[0]).toBe("▾ Todos (0/1)");
		expect(prefsFile(h)).toContain('"collapsed": false');

		await h.command("view");
		expect(h.notify).toHaveBeenLastCalledWith("Todos collapsed", "info");
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1");
		expect(prefsFile(h)).toContain('"collapsed": true');
	});
});

describe("argument completions", () => {
	it("registers a prefix-filtered completion callback on the registered command", () => {
		const h = setup();
		const completions = h.completions;
		expect(completions("")).toEqual([
			{ value: "status", label: "status", description: "Report tracking state and tasks" },
			{ value: "collapse", label: "collapse", description: "Collapse the overlay" },
			{ value: "expand", label: "expand", description: "Expand the overlay" },
			{ value: "view", label: "view", description: "Toggle collapsed/expanded" },
		]);
		expect(completions("col")).toEqual([{ value: "collapse", label: "collapse", description: "Collapse the overlay" }]);
		expect(completions("s")).toEqual([{ value: "status", label: "status", description: "Report tracking state and tasks" }]);
		expect(completions("e")).toEqual([{ value: "expand", label: "expand", description: "Expand the overlay" }]);
		expect(completions("v")).toEqual([{ value: "view", label: "view", description: "Toggle collapsed/expanded" }]);
		expect(completions("on")).toBeNull();
		expect(completions("x")).toBeNull();
	});
});

describe("obsolete and unknown arguments", () => {
	it("rejects removed on|off|toggle args with usage", async () => {
		const h = setup();
		await h.start();
		for (const arg of ["on", "off", "toggle", "frobnicate"]) {
			h.notify.mockClear();
			await h.command(arg);
			expect(h.notify).toHaveBeenCalledWith("Usage: /todos [status|collapse|expand|view]", "warning");
		}
		// Obsolete args must not change enablement.
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(false);
	});

	it("no shortcuts or other side effects on unknown args", async () => {
		const h = setup();
		await h.start();
		await h.command("OFF"); // case-sensitive lookup after trim/lowercase is applied
		expect(h.notify).toHaveBeenLastCalledWith("Usage: /todos [status|collapse|expand|view]", "warning");
	});
});

describe("tool exposure", () => {
	it("registers the tool inactive by default; reconciliation activates it for enabled sessions", async () => {
		const h = setup({ activeTools: ["read"] });
		expect(h.tools.get("todo").defaultActive).toBe(false);
		await h.enable();
		expect(h.activeTools()).toEqual(["read", "todo"]);
	});

	it("tool execution guard and guidance stay per session", async () => {
		const h = setup();
		await h.start();
		await expect(h.execute({ action: "list" })).rejects.toThrow(/disabled for this session/);
	});
});
