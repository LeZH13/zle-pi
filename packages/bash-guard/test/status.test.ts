import { describe, expect, it } from "vitest";
import { formatElapsed, renderStatus, type BashGuardStatusState } from "../src/status.js";
import type { WatchLive } from "../src/watchdog.js";

const identity = (text: string, _kind: "dim" | "warning") => text;

function state(overrides: Partial<BashGuardStatusState> = {}): BashGuardStatusState {
	return {
		guardMode: "ask",
		watchdogOn: true,
		jevAvailable: true,
		bashConflict: false,
		tally: { passed: 0, asked: 0, blocked: 0 },
		...overrides,
	};
}

function live(overrides: Partial<WatchLive> = {}): WatchLive {
	return { running: 1, elapsedSeconds: 42, ...overrides };
}

function check(overrides: Partial<NonNullable<WatchLive["check"]>> = {}): NonNullable<WatchLive["check"]> {
	return { status: "progressing", p: 0.92, agree: 0, agreeNeeded: 2, service: false, ...overrides };
}

/** Render with a styler that records each chunk's kind. */
function kinds(input: BashGuardStatusState): string[] {
	const seen: string[] = [];
	renderStatus(input, (text, kind) => {
		seen.push(`${kind}:${text}`);
		return text;
	});
	return seen;
}

describe("footer status: mode badge", () => {
	it("shows the compact ask badge while the guard prompts", () => {
		expect(renderStatus(state(), identity)).toBe("⛨ BG ask");
	});

	it("shows the deny badge in deny mode", () => {
		expect(renderStatus(state({ guardMode: "deny" }), identity)).toBe("⛨ BG deny");
	});

	it("shows off when nothing runs", () => {
		expect(renderStatus(state({ guardMode: "off", watchdogOn: false }), identity)).toBe("⛨ BG off");
	});

	it("keeps the shield and badge dim", () => {
		const seen = kinds(state({ guardMode: "deny" }));
		expect(seen).toContain("dim:⛨ BG");
		expect(seen).toContain("dim:deny");
	});
});

describe("footer status: idle tally", () => {
	it("shows only the badge before any risky command is judged", () => {
		expect(renderStatus(state(), identity)).toBe("⛨ BG ask");
	});

	it("counts passed, asked, and blocked, hiding zero buckets", () => {
		expect(renderStatus(state({ tally: { passed: 4, asked: 1, blocked: 0 } }), identity)).toBe("⛨ BG ask · 4✓ 1?");
		expect(renderStatus(state({ tally: { passed: 4, asked: 1, blocked: 1 } }), identity)).toBe("⛨ BG ask · 4✓ 1? 1✗");
	});

	it("warns only on blocked", () => {
		const seen = kinds(state({ tally: { passed: 4, asked: 1, blocked: 1 } }));
		expect(seen).toContain("dim:4✓");
		expect(seen).toContain("dim:1?");
		expect(seen).toContain("warning:1✗");
	});

	it("hides the tally when the guard is off", () => {
		expect(renderStatus(state({ guardMode: "off", watchdogOn: false, tally: { passed: 4, asked: 1, blocked: 0 } }), identity)).toBe(
			"⛨ BG off",
		);
	});
});

describe("footer status: running", () => {
	it("replaces the tally with the clock before the first check", () => {
		expect(renderStatus(state({ tally: { passed: 4, asked: 0, blocked: 0 }, live: live() }), identity)).toBe("⛨ BG ask · ⏱ 0:42");
	});

	it("shows the latest verdict and probability", () => {
		expect(renderStatus(state({ live: live({ elapsedSeconds: 190, check: check() }) }), identity)).toBe(
			"⛨ BG ask · ⏱ 3:10 progressing .92",
		);
	});

	it("shows kill progress in warning style", () => {
		const input = state({ live: live({ elapsedSeconds: 425, check: check({ status: "stuck", p: 0.88, agree: 1 }) }) });
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⏱ 7:05 stuck .88 kill 1/2");
		expect(kinds(input)).toContain("warning:stuck .88 kill 1/2");
	});

	it("shows a vetoed long-lived service", () => {
		expect(renderStatus(state({ live: live({ elapsedSeconds: 720, check: check({ status: "stuck", service: true }) }) }), identity)).toBe(
			"⛨ BG ask · ⏱ 12:00 service",
		);
	});

	it("shows the running count when several commands run", () => {
		expect(renderStatus(state({ live: live({ running: 2, elapsedSeconds: 425, check: check({ status: "waiting", p: 0.81 }) }) }), identity)).toBe(
			"⛨ BG ask · ⏱2 7:05 waiting .81",
		);
	});

	it("keeps a degraded label before the running segment", () => {
		expect(renderStatus(state({ jevFailure: "timeout", live: live({ elapsedSeconds: 190 }) }), identity)).toBe(
			"⛨ BG ask · jev ✗ timeout · ⏱ 3:10",
		);
	});

	it("ignores live data when the watchdog cannot act", () => {
		expect(renderStatus(state({ jevAvailable: false, live: live() }), identity)).toBe("⛨ BG ask · rules-only");
		expect(renderStatus(state({ watchdogOn: false, live: live() }), identity)).toBe("⛨ BG ask · guard-only");
	});

	it("shows off plus watch-only and the clock when only the watchdog runs", () => {
		expect(renderStatus(state({ guardMode: "off", live: live({ elapsedSeconds: 190 }) }), identity)).toBe(
			"⛨ BG off · watch-only · ⏱ 3:10",
		);
		expect(kinds(state({ guardMode: "off", live: live() }))).toContain("dim:watch-only");
	});

	it("never shows a misleading ask badge when the guard is off", () => {
		expect(renderStatus(state({ guardMode: "off", live: live() }), identity)).not.toContain("ask");
	});
});

describe("footer status: degraded", () => {
	const tally = { passed: 4, asked: 2, blocked: 0 };

	it("rules-only without a classifier", () => {
		expect(renderStatus(state({ jevAvailable: false, tally: { passed: 0, asked: 2, blocked: 0 } }), identity)).toBe(
			"⛨ BG ask · rules-only · 2?",
		);
	});

	it("last Jev failure in warning style", () => {
		const input = state({ jevFailure: "timeout", tally });
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · jev ✗ timeout · 4✓ 2?");
		expect(kinds(input)).toContain("warning:jev ✗ timeout");
	});

	it("guard-only and watch-only", () => {
		expect(renderStatus(state({ watchdogOn: false, tally }), identity)).toBe("⛨ BG ask · guard-only · 4✓ 2?");
		expect(renderStatus(state({ guardMode: "off", tally }), identity)).toBe("⛨ BG off · watch-only");
	});

	it("env-enforced deny stays visible with the watchdog off", () => {
		expect(renderStatus(state({ guardMode: "deny", watchdogOn: false, tally }), identity)).toBe("⛨ BG deny · guard-only · 4✓ 2?");
	});

	it("bash conflict in warning style", () => {
		const input = state({ bashConflict: true, tally });
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⚠ bash conflict · 4✓ 2?");
		expect(kinds(input)).toContain("warning:⚠ bash conflict");
	});

	it("deny is unaffected by a bash conflict", () => {
		expect(renderStatus(state({ guardMode: "deny", bashConflict: true, tally }), identity)).toBe(
			"⛨ BG deny · ⚠ bash conflict · 4✓ 2?",
		);
	});
});

describe("formatElapsed", () => {
	it("formats m:ss and h:mm:ss", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(65)).toBe("1:05");
		expect(formatElapsed(3725)).toBe("1:02:05");
	});
});
