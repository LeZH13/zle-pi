import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../extensions/prefs.js";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-todo-prefs-"));
}

describe("preferences", () => {
	it("defaults to collapsed when nothing is stored", () => {
		expect(DEFAULT_PREFS).toEqual({ collapsed: true });
		expect(loadPrefs(tempDir())).toEqual(DEFAULT_PREFS);
	});

	it("ignores unknown keys and falls back on a malformed file", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "pi-todo"), { recursive: true });
		// A legacy global "enabled" key is not migrated and has no effect.
		writeFileSync(join(dir, "pi-todo", "config.json"), JSON.stringify({ enabled: false }));
		expect(loadPrefs(dir)).toEqual(DEFAULT_PREFS);

		writeFileSync(join(dir, "pi-todo", "config.json"), "{ not json");
		expect(loadPrefs(dir)).toEqual(DEFAULT_PREFS);

		writeFileSync(join(dir, "pi-todo", "config.json"), JSON.stringify({ collapsed: "bogus" }));
		expect(loadPrefs(dir)).toEqual(DEFAULT_PREFS);
	});

	it("round-trips through savePrefs, creating the directory", () => {
		const dir = join(tempDir(), "nested", "pi-todo");
		savePrefs({ collapsed: false }, dir);
		expect(loadPrefs(dir)).toEqual({ collapsed: false });
	});
});
