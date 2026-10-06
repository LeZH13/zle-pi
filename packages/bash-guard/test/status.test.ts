import { describe, expect, it } from "vitest";
import { renderStatus, type BashGuardStatusState } from "../src/status.js";

/** Identity styler: asserts the plain text, ignoring the kind. */
const plain = (text: string): string => text;
const identity = (text: string, _kind: "dim" | "warning") => text;

function state(overrides: Partial<BashGuardStatusState> = {}): BashGuardStatusState {
	return {
		flagDisabled: false,
		guardOn: true,
		watchdogOn: true,
		jevAvailable: true,
		running: 0,
		bashConflict: false,
		...overrides,
	};
}

describe("footer status line", () => {
	it("renders the normal form", () => {
		expect(renderStatus(state(), identity)).toBe("⛨ bg · watch · jev");
	});

	it("shows the watched-command count while commands run", () => {
		expect(renderStatus(state({ running: 2 }), identity)).toBe("⛨ bg · watch(2) · jev");
	});

	it("degrades to rules-only without a Jev model (watch is off without Jev)", () => {
		expect(renderStatus(state({ jevAvailable: false }), identity)).toBe("⛨ bg · rules-only");
	});

	it("omits the watch segment when the watchdog is toggled off", () => {
		expect(renderStatus(state({ watchdogOn: false }), identity)).toBe("⛨ bg · jev");
	});

	it("omits the bg segment when the guard is off", () => {
		expect(renderStatus(state({ guardOn: false }), identity)).toBe("⛨ watch · jev");
	});

	it("collapses to off when both are off or the flag is set", () => {
		expect(renderStatus(state({ guardOn: false, watchdogOn: false }), identity)).toBe("⛨ off");
		expect(renderStatus(state({ flagDisabled: true, guardOn: true, watchdogOn: true }), identity)).toBe("⛨ off");
	});

	it("renders guard-only with no Jev as bg · rules-only", () => {
		expect(renderStatus(state({ watchdogOn: false, jevAvailable: false }), identity)).toBe("⛨ bg · rules-only");
	});

	it("appends the conflict note in warning style", () => {
		const kinds: string[] = [];
		const tagged = (text: string, kind: "dim" | "warning") => {
			kinds.push(`${kind}:${text}`);
			return text;
		};
		const line = renderStatus(state({ bashConflict: true }), tagged);
		expect(line).toBe("⛨ bg · watch · jev · ⚠ bash conflict");
		expect(kinds).toContain("warning:⚠ bash conflict");
		expect(kinds).toContain("dim:bg");
	});

	it("does not append the conflict note when nothing is active", () => {
		expect(renderStatus(state({ guardOn: false, watchdogOn: false, bashConflict: true }), identity)).toBe("⛨ off");
	});

	it("passes every chunk through the styler", () => {
		const calls: string[] = [];
		renderStatus(state(), (text) => {
			calls.push(text);
			return text;
		});
		expect(calls.filter((text) => text !== " · ")).toEqual(["⛨ ", "bg", "watch", "jev"]);
	});
});

describe("footer status styler use in wiring", () => {
	it("plain fallback styler matches the rendered text", () => {
		// The wiring falls back to plain text when the theme is unavailable;
		// the identity styler produces the same string.
		expect(renderStatus(state({ running: 1 }), plain)).toBe("⛨ bg · watch(1) · jev");
	});
});
