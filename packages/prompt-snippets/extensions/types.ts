export type SnippetPlacement = "prepend" | "append";
export type SnippetSource = "bundled" | "global" | "project";

export interface Snippet {
	/** Filename identifier, e.g. "ask-questions.md" */
	id: string;
	/** Display name */
	name: string;
	/** Short description shown in menu */
	description: string;
	/** Placement before or after user message */
	placement: SnippetPlacement;
	/** Sort order within placement group (ascending) */
	order: number;
	/** Prompt content inserted into message */
	body: string;
	/** Origin of snippet definition */
	source: SnippetSource;
	/** File path on disk */
	filePath: string;
}

export interface SnippetConfig {
	/** List of snippet IDs (with or without .md) to disable */
	disabled?: string[];
}

export interface LoadSnippetsOptions {
	/** Current working directory for project snippets */
	cwd?: string;
	/** Pi agent directory (defaults to getAgentDir()) */
	agentDir?: string;
	/** Bundled snippets directory in extension/package */
	bundledDir?: string;
	/** Whether project-local configuration and snippets are trusted */
	isProjectTrusted?: boolean;
}
