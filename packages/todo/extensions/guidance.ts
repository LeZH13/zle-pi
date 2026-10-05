/*
 * Guidance the model receives while the todo tool is active. Deliberately
 * less eager than the upstream text: only genuinely complex work or an
 * explicit user request should open a list, and new instructions alone do
 * not justify creating or revising tasks. Task completion discipline is
 * retained in full.
 */

export const PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

export const PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ meaningful steps that have meaningful, verifiable milestones, or when the user explicitly asks you to track tasks. Skip single-step, trivial, or conversational work, and do not split work artificially just to fill the list.",
	"Do not create or revise todos solely because new instructions arrived — add or change tasks only when they genuinely change the plan.",
	"When starting a task from the list, mark it in_progress BEFORE beginning work (pass activeForm, a present-continuous label). Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a task for the blocker instead.",
	"To change a task's status, call update with the task id and target status, e.g. {\"action\":\"update\",\"id\":3,\"status\":\"completed\"}. Express dependencies with blockedBy (create) or addBlockedBy / removeBlockedBy (update); cycles are rejected. list hides deleted tasks unless includeDeleted:true.",
];
