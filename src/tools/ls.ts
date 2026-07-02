import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import {
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	observationBudgetExhausted,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;

function parseLimit(value: unknown): number {
	return typeof value === "number" && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
}

export const lsTool: ToolSpec = {
	name: ToolNames.Ls,
	description: 'List directory entries sorted alphabetically, "/" suffix for directories, dotfiles included.',
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list." })),
		limit: Type.Optional(Type.Number({ description: `Max entries (default ${DEFAULT_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const rootArg = typeof args.path === "string" ? args.path : ".";
		const root = resolveReadPath(rootArg);
		const limit = parseLimit(args.limit);

		try {
			const rootStat = statSync(root);
			if (!rootStat.isDirectory()) {
				return { kind: "error", message: `ls: not a directory: ${root}` };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}
		const reservation = reserveObservation(OBSERVE_SELF_CAPS.ls, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.Ls,
				unit: "entries",
				reservation,
				subject: `listing ${rootArg}`,
				hint: "Use find with a narrower pattern or continue in a follow-up turn.",
			});
		}

		try {
			const entries = readdirSync(root).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			const outputEntries: string[] = [];
			let entryLimitReached = false;
			for (const entry of entries) {
				if (outputEntries.length >= limit) {
					entryLimitReached = true;
					break;
				}
				try {
					const entryStat = statSync(path.join(root, entry));
					outputEntries.push(entryStat.isDirectory() ? `${entry}/` : entry);
				} catch {
					// Mirror the reference tool: skip entries that disappear or cannot be statted.
				}
			}

			if (outputEntries.length === 0) {
				return finalizeObservation({
					tool: ToolNames.Ls,
					unit: "entries",
					output: "(empty directory)",
					shownCount: 0,
					totalCount: 0,
					truncated: false,
					reservation,
					...(options ? { options } : {}),
				});
			}

			const fullOutput = outputEntries.join("\n");
			const truncation = truncateHead(fullOutput, {
				maxBytes: reservation.callCapBytes,
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			const truncated = entryLimitReached || truncation.truncated;
			return finalizeObservation({
				tool: ToolNames.Ls,
				unit: "entries",
				output: truncation.content,
				// Offload only when the byte cap cut collected entries; a bare
				// entry limit continues via `next`.
				...(truncation.truncated ? { fullOutput } : {}),
				shownCount: truncation.outputLines,
				totalCount: entries.length,
				truncated,
				...(entryLimitReached ? { next: `limit=${limit * 2}` } : {}),
				reservation,
				...(options ? { options } : {}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}
	},
};
