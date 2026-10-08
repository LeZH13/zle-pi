import { describe, expect, it } from "vitest";
import { ALLOW_ENTRY_TYPE, restoreState, SETTINGS_ENTRY_TYPE } from "../src/state.js";

const settings = (data: unknown) => ({ type: "custom", customType: SETTINGS_ENTRY_TYPE, data });
const allow = (command: string) => ({ type: "custom", customType: ALLOW_ENTRY_TYPE, data: { command } });

describe("branch settings", () => {
	it("leaves config in control when no settings were saved", () => {
		expect(restoreState([])).toEqual({ settings: undefined, allowedCommands: [] });
	});

	it.each(["ask", "deny", "off"])("restores guard mode %s", (guard) => {
		expect(restoreState([settings({ guard })]).settings).toEqual({ guard });
	});

	it("restores only explicitly selected settings from the last snapshot", () => {
		expect(restoreState([settings({ guard: "deny" }), settings({ guard: "ask", watchdog: false })]).settings).toEqual({ guard: "ask", watchdog: false });
		expect(restoreState([settings({ watchdog: true })]).settings).toEqual({ watchdog: true });
		expect(restoreState([settings({})]).settings).toEqual({});
	});

	it.each([null, [], "deny", { guard: true }, { guard: "prompt" }, { guard: "on" }, { watchdog: "off" }])("ignores malformed snapshots without discarding valid settings: %j", (bad) => {
		expect(restoreState([settings({ guard: "deny", watchdog: false }), settings(bad)]).settings).toEqual({ guard: "deny", watchdog: false });
	});

	it("ignores obsolete toggle entries", () => {
		expect(restoreState([{ type: "custom", customType: "bash-guard-toggles", data: { guard: false, watchdog: false } }]).settings).toBeUndefined();
	});

	it("restores exact-command approvals only from the supplied branch", () => {
		expect(restoreState([allow("rm -rf dist"), allow("rm -rf dist"), allow("rm -rf ./dist"), { type: "custom", customType: ALLOW_ENTRY_TYPE, data: { command: "" } }]).allowedCommands).toEqual(["rm -rf dist", "rm -rf ./dist"]);
		expect(restoreState([]).allowedCommands).toEqual([]);
	});
});
