import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASH_GUARD_RUNTIME_SYMBOL, publishRuntimeMarker, readPackageVersion } from "../src/runtime.js";

function globalSymbols(): Record<symbol, unknown> {
	return globalThis as unknown as Record<symbol, unknown>;
}

function marker(): unknown {
	return globalSymbols()[BASH_GUARD_RUNTIME_SYMBOL];
}

describe("runtime marker", () => {
	it("publishes a not-ready marker under the shared symbol", () => {
		const handle = publishRuntimeMarker(globalSymbols(), "1.2.3");
		expect(marker()).toBe(handle.marker);
		expect(handle.marker.ready).toBe(false);
		expect(handle.marker.version).toBe("1.2.3");
		expect(handle.marker.approvalMode).toBe("ask");
		expect(handle.marker.guardEnabled).toBe(false);
		expect(handle.marker.envEnforced).toBe(false);
		expect(handle.marker.error).toBeUndefined();
	});

	it("stays live: set updates what consumers read through the getters", () => {
		const handle = publishRuntimeMarker(globalSymbols(), "1.2.3");
		handle.set({ ready: true, approvalMode: "deny", guardEnabled: true, envEnforced: true, error: "invalid env" });
		expect(handle.marker.ready).toBe(true);
		expect(handle.marker.approvalMode).toBe("deny");
		expect(handle.marker.guardEnabled).toBe(true);
		expect(handle.marker.envEnforced).toBe(true);
		expect(handle.marker.error).toBe("invalid env");
		handle.clear();
		expect(marker()).toBeUndefined();
	});

	it("replaces any previous marker on publish (factory reload)", () => {
		const first = publishRuntimeMarker(globalSymbols(), "1.0.0");
		const second = publishRuntimeMarker(globalSymbols(), "2.0.0");
		expect(marker()).toBe(second.marker);
		expect(second.marker.version).toBe("2.0.0");
		// The old runtime's shutdown must not clear the newer marker.
		first.clear();
		expect(marker()).toBe(second.marker);
		second.clear();
		expect(marker()).toBeUndefined();
	});

	it("readPackageVersion reads the package version", () => {
		const fromDisk = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;
		expect(readPackageVersion(import.meta.url)).toBe(fromDisk);
		expect(readPackageVersion(import.meta.url)).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("readPackageVersion returns an empty string when the file is unreadable", () => {
		expect(readPackageVersion("file:///nonexistent/root/index.ts")).toBe("");
	});
});
