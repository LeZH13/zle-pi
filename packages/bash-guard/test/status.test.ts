import { describe, expect, it } from "vitest";
import {
	formatElapsed,
	formatWatchCheck,
	renderStatus,
	renderStatusDetails,
	type BashGuardStatusState,
	type StatusDetailsInput,
} from "../src/status.js";
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
	return { running: 1, warnings: 0, command: "sleep 60", elapsedSeconds: 42, ...overrides };
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
	it("shows pending decisions ahead of check verdicts", () => {
		const input = state({ live: live({ running: 3, pendingDecisions: 2, check: check() }) });
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⏱ 3 watched · 2 awaiting decision");
		expect(kinds(input)).toContain("warning:2 awaiting decision");
	});
	it("replaces the tally with the clock before the first check", () => {
		expect(renderStatus(state({ tally: { passed: 4, asked: 0, blocked: 0 }, live: live() }), identity)).toBe("⛨ BG ask · ⏱ 0:42");
	});

	it("shows the latest verdict and probability", () => {
		expect(renderStatus(state({ live: live({ elapsedSeconds: 190, check: check() }) }), identity)).toBe(
			"⛨ BG ask · ⏱ 3:10 progressing .92",
		);
	});

	it("shows kill progress in warning style", () => {
		const input = state({ live: live({ warnings: 1, elapsedSeconds: 425, check: check({ status: "stuck", p: 0.88, agree: 1 }) }) });
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⏱ 7:05 stuck .88 (1/2 agree)");
		expect(kinds(input)).toContain("warning:stuck .88 (1/2 agree)");
	});

	it("shows a vetoed long-lived service", () => {
		expect(renderStatus(state({ live: live({ elapsedSeconds: 720, check: check({ status: "stuck", service: true }) }) }), identity)).toBe(
			"⛨ BG ask · ⏱ 12:00 service",
		);
	});

	it("shows the running count before any check completes", () => {
		expect(renderStatus(state({ live: live({ running: 2, elapsedSeconds: 42 }) }), identity)).toBe(
			"⛨ BG ask · ⏱2 0:42",
		);
	});

	it("spotlights the command name, timer, and verdict when several commands run", () => {
		expect(
			renderStatus(
				state({
					live: live({
						running: 2,
						command: "cargo test",
						elapsedSeconds: 190,
						check: check({ status: "progressing", p: 0.92 }),
					}),
				}),
				identity,
			),
		).toBe("⛨ BG ask · ⏱2 · cargo test 3:10 progressing .92");
	});

	it("shows a single warning spotlight without a redundant warning count", () => {
		const input = state({
			live: live({
				running: 3,
				warnings: 1,
				command: "/usr/local/bin/pytest -q",
				elapsedSeconds: 425,
				check: check({ status: "stuck", p: 0.88, agree: 1 }),
			}),
		});
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⏱3 · pytest -q 7:05 stuck .88 (1/2 agree)");
		const seen = kinds(input);
		expect(seen).toContain("dim:⏱3");
		expect(seen).toContain("warning:stuck .88 (1/2 agree)");
	});

	it("surfaces a compact multi-warning count when two or more commands warn", () => {
		const input = state({
			live: live({
				running: 3,
				warnings: 2,
				command: "pytest",
				elapsedSeconds: 190,
				check: check({ status: "stuck", p: 0.88, agree: 1 }),
			}),
		});
		expect(renderStatus(input, identity)).toBe("⛨ BG ask · ⏱3 2⚠ · pytest 3:10 stuck .88 (1/2 agree)");
		const seen = kinds(input);
		expect(seen).toContain("dim:⏱3");
		expect(seen).toContain("warning:2⚠");
		expect(seen).toContain("warning:stuck .88 (1/2 agree)");
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

function detailsInput(overrides: {
	guard?: Partial<StatusDetailsInput["guard"]>;
	watchdog?: Partial<StatusDetailsInput["watchdog"]>;
	jev?: Partial<StatusDetailsInput["jev"]>;
	config?: Partial<StatusDetailsInput["config"]>;
	recentChecks?: StatusDetailsInput["recentChecks"];
} = {}): StatusDetailsInput {
	return {
		guard: {
			mode: "ask",
			approvalMode: "ask",
			approvalSource: "config",
			envEnforced: false,
			configEnabled: true,
			allowBelow: 0.25,
			sessionAllowedCount: 0,
			allowPatternCount: 0,
			extraRiskyPatternCount: 0,
			tally: { passed: 0, asked: 0, blocked: 0 },
			...overrides.guard,
		},
		watchdog: {
			on: true,
			stopMode: "ask",
			stopModeSource: "config",
			configEnabled: true,
			running: 0,
			pendingDecisions: 0,
			bashConflict: false,
			bashRegistered: true,
			firstCheckSec: 120,
			intervalSec: 300,
			agreeChecks: 2,
			confidence: 0.8,
			...overrides.watchdog,
		},
		jev: {
			available: true,
			model: "openrouter/~typesafe/jev-latest",
			timeoutMs: 6000,
			usage: { totalTokens: 0, cost: 0 },
			...overrides.jev,
		},
		config: {
			flagDisabled: false,
			files: [],
			...overrides.config,
		},
		recentChecks: overrides.recentChecks ?? [],
	};
}

describe("renderStatusDetails", () => {
	it("renders a concise, scannable default summary and sections", () => {
		const out = renderStatusDetails(detailsInput());
		expect(out).toBe([
			"Bash Guard · Status",
			"Guard: ask · Watchdog: ask · Jev: on",
			"",
			"── Guard ──",
			"  Mode           ask (config)",
			"  Decisions      0 passed by Jev · 0 approved · 0 blocked",
			"  Allow below    0.25 (risk score)",
			"  Allowlist      0 session commands · 0 config patterns",
			"  Extra risky    0 custom patterns",
			"",
			"── Watchdog ──",
			"  Mode           ask (config)",
			"  Watching       0 running",
			"  Bash override  active",
			"  Checks         first at 120s, then every 300s",
			"  Stop rule      2 consecutive checks ≥ 0.8 confidence",
			"",
			"── Jev classifier ──",
			"  Status         on",
			"  Model          openrouter/~typesafe/jev-latest",
			"  Timeout        6000ms",
			"",
			"── Configuration ──",
			"  Config files   none (using defaults)",
		].join("\n"));
	});

	it("pluralizes counts properly and surfaces warnings, usage, config files, and redacted recent checks", () => {
		const out = renderStatusDetails(detailsInput({
			guard: {
				mode: "deny",
				approvalMode: "deny",
				approvalSource: "session",
				sessionAllowedCount: 1,
				allowPatternCount: 1,
				extraRiskyPatternCount: 1,
				tally: { passed: 4, asked: 1, blocked: 2 },
			},
			watchdog: {
				stopMode: "notify-only",
				stopModeSource: "session",
				running: 2,
				pendingDecisions: 1,
				bashConflict: true,
				agreeChecks: 1,
			},
			jev: {
				lastFailure: "timeout",
				usage: { totalTokens: 1240, cost: 0.0012 },
			},
			config: {
				files: ["/home/u/.pi/agent/bash-guard.json", "/repo/.pi/bash-guard.json"],
				ignoredProjectKeys: { path: "/repo/.pi/bash-guard.json", keys: ["guard.enabled"] },
			},
			recentChecks: [
				{
					command: "OPENAI_API_KEY=sk-proj-secret1234567890 npm run dev",
					checks: [
						{ elapsedSeconds: 120, status: "progressing", probabilities: { progressing: 0.92 }, persistent: 0.85, outcome: "pass" },
						{ elapsedSeconds: 420, status: "stuck", probabilities: { stuck: 0.88 }, persistent: 0.12, outcome: "agree 1/2" },
						{ elapsedSeconds: 720, outcome: "failed: timeout" },
					],
				},
			],
		}));

		expect(out).toContain("Guard: deny · Watchdog: notify-only · Jev: on · ⚠ bash conflict · ⚠ jev: timeout · ⚠ project keys ignored");
		expect(out).toContain("  Allowlist      1 session command · 1 config pattern");
		expect(out).toContain("  Extra risky    1 custom pattern");
		expect(out).toContain("  Watching       2 running · ⚠ 1 awaiting decision");
		expect(out).toContain("  Bash override  ⚠ unavailable (owned by another extension)");
		expect(out).toContain("  Stop rule      1 consecutive check ≥ 0.8 confidence");
		expect(out).toContain("  Last error     ⚠ timeout");
		expect(out).toContain("  Usage          1240 tokens · $0.0012");
		expect(out).toContain("  Config files   /home/u/.pi/agent/bash-guard.json\n                 /repo/.pi/bash-guard.json");
		expect(out).toContain("  Ignored keys   ⚠ guard.enabled");
		expect(out).toContain("  Project file   /repo/.pi/bash-guard.json");
		expect(out).toContain("── Recent watchdog checks ──");
		expect(out).not.toContain("sk-proj-secret1234567890");
		expect(out).toContain("    2:00   progressing (0.92) · service 0.85 · pass");
		expect(out).toContain("    7:00   stuck (0.88) · service 0.12 · agree 1/2");
		expect(out).toContain("    12:00  ⚠ failed: timeout");
	});

	it("explains that --no-bash-guard leaves launch-enforced deny active", () => {
		const out = renderStatusDetails(detailsInput({
			guard: { mode: "deny", approvalMode: "deny", approvalSource: "env", envEnforced: true },
			watchdog: { on: false },
			config: { flagDisabled: true },
		}));
		expect(out).toContain("Guard: deny · Watchdog: off");
		expect(out).toContain("--no-bash-guard (watchdog disabled; guard stays on in enforced deny mode)");
		expect(out).not.toContain("disables guard & watchdog");
	});

	it("explains --no-bash-guard and session off overrides clearly", () => {
		const flagged = renderStatusDetails(detailsInput({
			guard: { mode: "off" },
			watchdog: { on: false },
			config: { flagDisabled: true },
		}));
		expect(flagged).toContain("Guard: off · Watchdog: off · Jev: on · ⚠ --no-bash-guard");
		expect(flagged).toContain("  Mode           off (disabled by --no-bash-guard)");
		expect(flagged).toContain("  Launch flag    ⚠ --no-bash-guard (disables guard & watchdog)");

		const sessionOff = renderStatusDetails(detailsInput({
			guard: { mode: "off", approvalSource: "env", approvalMode: "ask", sessionSetting: "off" },
			watchdog: { on: false, sessionSetting: false },
		}));
		expect(sessionOff).toContain("  Mode           off (disabled in session; env approval: ask)");
		expect(sessionOff).toContain("  Mode           off (disabled in session; stop mode: ask)");
	});
});

describe("formatWatchCheck", () => {
	it("formats checks with and without probabilities", () => {
		expect(formatWatchCheck({
			elapsedSeconds: 65,
			status: "waiting",
			probabilities: { waiting: 0.81 },
			persistent: 0.4,
			outcome: "pass",
		})).toBe("1:05   waiting (0.81) · service 0.40 · pass");
		expect(formatWatchCheck({ elapsedSeconds: 300, outcome: "failed: aborted" })).toBe("5:00   ⚠ failed: aborted");
	});
});
