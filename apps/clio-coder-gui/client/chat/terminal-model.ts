// The commands a task ran, read from its terminal-shaped tool calls. This is a log of what Clio ran
// and what came back, not a shell: nothing typed in the browser reaches a process.

import type { TimelineItem } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";
import { presentTool, readWire } from "./tool-presentation.js";

export interface CommandRun {
	readonly id: string;
	/** The command line as the agent wrote it, first line only for a multi-line script. */
	readonly command: string;
	readonly tone: StatusTone;
	readonly statusLabel: string;
	/** The one fact worth reading beside the command, such as an exit code. */
	readonly digest: string | null;
	readonly output: string;
	readonly truncated: boolean;
	readonly running: boolean;
	readonly failed: boolean;
}

/** `tools` in the order the calls were made. */
export function commandRuns(tools: readonly TimelineItem[], workspaceRoot?: string): CommandRun[] {
	const runs: CommandRun[] = [];
	for (const item of tools) {
		const card = presentTool(item, workspaceRoot === undefined ? {} : { workspaceRoot });
		if (card.body !== "terminal") continue;
		const typed = readWire(item).input.command;
		runs.push({
			id: item.id,
			command:
				(typeof typed === "string" && typed.trim() !== "" ? typed.split("\n", 1)[0] : card.headline) ?? card.headline,
			tone: card.tone,
			statusLabel: card.statusLabel,
			digest: card.digest,
			output: card.output.text,
			truncated: card.output.truncated,
			running: card.output.running || !card.settled,
			failed: card.failed,
		});
	}
	return runs;
}
