/*
 * Real mixed-batch regression against @earendil-works/pi-agent-core's
 * runAgentLoop: one assistant batch issues a direct todo.create('Direct') and
 * a parent tool that performs a nested todo.create('Nested') (toolCallId
 * `<parentId>/<n>`). Tool results are recorded on the branch AFTER all
 * executions, so replay must come from execution-time snapshot entries, not
 * transcript tool results.
 */
import { runAgentLoop, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import todoExtension from "../extensions/index.js";
import { getTodos, replayFromBranch } from "../extensions/store.js";
import { SNAPSHOT_ENTRY_TYPE, TOOL_NAME, TodoParamsSchema, type TaskDetails } from "../extensions/tasks.js";
import { setup } from "./harness.js";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		timestamp: Date.now(),
		stopReason,
		usage,
	} as unknown as AssistantMessage;
}

describe("real agent loop: parallel direct + nested todo creation", () => {
	it("replays both mutations from execution-time snapshots", async () => {
		const h = setup();
		await h.enable();
		// Bridge the registered extension tool into an AgentTool the loop can run,
		// supplying the session context pi normally injects as the 5th argument.
		const raw = h.tools.get(TOOL_NAME);
		const agentCtx = { sessionManager: h.manager };
		const todoTool: AgentTool = {
			name: TOOL_NAME,
			label: raw.label,
			description: raw.description,
			parameters: TodoParamsSchema,
			execute: (toolCallId, params, signal, onUpdate) =>
				raw.execute(toolCallId, params, signal, onUpdate, agentCtx as never),
		};

		// A parent tool performing a nested todo call, like ctx.executeTool does:
		// the nested id is `<parentId>/<n>` and leaves no transcript result.
		const parentTool: AgentTool = {
			name: "delegate_todo",
			label: "Delegate todo",
			description: "Creates a nested todo",
			parameters: Type.Object({}),
			execute: (toolCallId, _params, signal, onUpdate) =>
				todoTool.execute!(
					`${toolCallId}/1`,
					{ action: "create", subject: "Nested" } as never,
					signal,
					onUpdate,
				) as never,
		};

		const firstTurn = assistantMessage(
			[
				{ type: "toolCall", id: "call-direct", name: TOOL_NAME, arguments: { action: "create", subject: "Direct" } },
				{ type: "toolCall", id: "call-parent", name: "delegate_todo", arguments: {} },
			] as ToolCall[],
			"toolUse",
		);
		const secondTurn = assistantMessage([{ type: "text", text: "Created both todos" }], "stop");

		let turn = 0;
		const streamFn = () => {
			const stream = createAssistantMessageEventStream();
			const message = ++turn === 1 ? firstTurn : secondTurn;
			for (let index = 0; index < message.content.length; index++) {
				const block = message.content[index];
				if (block.type === "toolCall") {
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
				}
			}
			stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
			return stream;
		};

		const emit = async (event: AgentEvent) => {
			// pi records finalized messages on message_end; snapshots were already
			// appended at execution time by the tool itself.
			if (event.type === "message_end") h.manager.appendMessage(event.message as never);
		};

		await runAgentLoop(
			[{ role: "user", content: "Track two todos", timestamp: Date.now() }],
			{ messages: [], tools: [todoTool, parentTool] },
			{
				model: {
					id: "fake",
					name: "Fake",
					api: "openai-completions",
					provider: "fake",
					baseUrl: "",
					input: ["text"],
					reasoning: false,
					cost: {},
				} as never,
				convertToLlm: (messages) => messages as never,
			},
			emit,
			undefined,
			streamFn as unknown as Parameters<typeof runAgentLoop>[5],
		);

		const sid = h.manager.getSessionId();
		const subjects = (tasks: readonly { subject: string }[]) => tasks.map((t) => t.subject).sort();

		// Live state carries both mutations.
		expect(subjects(getTodos(sid))).toEqual(["Direct", "Nested"]);

		// The branch records the stale per-call view, too — replay must ignore it.
		const staleDirectResult = h.manager
			.getBranch()
			.some(
				(entry: any) =>
					entry.type === "message" &&
					entry.message?.role === "toolResult" &&
					entry.message?.toolName === TOOL_NAME &&
					entry.message?.details?.tasks?.length === 1,
			);
		expect(staleDirectResult).toBe(true);

		// Replay from snapshot entries matches the live state exactly.
		const replayed = replayFromBranch({ sessionManager: h.manager });
		expect(subjects(replayed.tasks)).toEqual(["Direct", "Nested"]);
		expect(replayed.nextId).toBe(Math.max(0, ...getTodos(sid).map((t) => t.id)) + 1);

		// Snapshots exist for both executions.
		const snapshotSubjects = h.manager
			.getBranch()
			.filter((entry: any) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE)
			.map((entry: any) => subjects((entry.data as TaskDetails).tasks));
		expect(snapshotSubjects.at(-1)).toEqual(["Direct", "Nested"]);
	});
});
