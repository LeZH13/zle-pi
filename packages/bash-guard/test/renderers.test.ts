import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import bashGuardExtension from "../extensions/index.js";

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

function getResolver(): Resolver {
	let resolver: Resolver | undefined;
	const pi = {
		registerFlag: vi.fn(),
		registerToolRenderer: (value: Resolver) => { resolver = value; },
		on: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	bashGuardExtension(pi);
	return resolver!;
}

describe("bash-guard renderer delegation", () => {
	it.each(["codemode", "get_search_content", "read", "unknown_tool"])(
		"preserves the downstream renderer for %s",
		(toolName) => {
			const base = { renderCall: vi.fn(), renderResult: vi.fn() };
			const next = vi.fn(() => base);
			expect(getResolver()(toolName, next)).toBe(base);
			expect(next).toHaveBeenCalledOnce();
		},
	);

	it("delegates even when no downstream renderer exists", () => {
		const next = vi.fn(() => undefined);
		expect(getResolver()("unknown_tool", next)).toBeUndefined();
		expect(next).toHaveBeenCalledOnce();
	});

	it("decorates only bash calls and preserves its result renderer", () => {
		const base = { renderCall: vi.fn(), renderResult: vi.fn() };
		const next = vi.fn(() => base);
		const result = getResolver()("bash", next);
		expect(next).toHaveBeenCalledOnce();
		expect(result?.renderCall).not.toBe(base.renderCall);
		expect(result?.renderResult).toBe(base.renderResult);
	});
});
