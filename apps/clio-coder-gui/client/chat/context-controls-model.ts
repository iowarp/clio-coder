import type { CommandCatalog, CommandDescriptor } from "../../contracts/steering.js";
import type { CommandFields } from "./command-model.js";
import { type CommandPlanResult, planCommand } from "./command-model.js";

const ACTION_LABELS: Readonly<Record<string, string>> = {
	init: "Initialize / adopt",
	refresh: "Refresh source index",
	compact: "Compact session history",
	recall: "Recall a result",
	recover: "Recover a handoff",
	reset: "Reset generated context",
};

export function contextCommand(catalog: CommandCatalog | undefined): CommandDescriptor | undefined {
	return catalog?.commands.find((command) => command.name === "context");
}

export function contextActions(
	command: CommandDescriptor | undefined,
): { key: string; label: string; summary: string }[] {
	return Object.keys(command?.args.subcommands ?? {})
		.filter((key) => Object.hasOwn(ACTION_LABELS, key))
		.map((key) => ({
			key,
			label: ACTION_LABELS[key] ?? key,
			summary: command?.subcommandSummaries?.[key] ?? "",
		}));
}

export function planContextCommand(
	command: CommandDescriptor,
	action: string,
	fields: CommandFields,
): CommandPlanResult {
	if (action === "reset" && fields["flag:--yes"] !== true)
		return { error: "Confirm removal of generated context before running reset." };
	return planCommand(command, { ...fields, subcommand: action });
}

export const CONTEXT_FLAG_LABELS: Readonly<Record<string, string>> = {
	"--preview": "Preview changes",
	"--adopt": "Ingest existing agent instructions",
	"--apply": "Apply the handbook proposal",
	"--rewrite": "Rewrite the project handbook",
	"--propose": "Write a handbook proposal",
	"--global": "Include global instruction sources",
	"--include-global": "Include global instruction sources",
	"--heuristic": "Use the heuristic path",
	"--depth": "Exploration depth",
	"--yes": "Confirm removal of generated project context",
	"--all": "Also remove CLIO-CODER.md",
};

export const CONTEXT_FIELD_LABELS: Readonly<Record<string, string>> = {
	instructions: "Instructions for compaction (optional)",
	ref: "Evicted result reference",
	handoffId: "Handoff ID",
	action: "Recovery action",
};
