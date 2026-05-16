import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;

function parseLimit(value: unknown): number {
	return typeof value === "number" && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
}

export const lsTool: ToolSpec = {
	name: ToolNames.Ls,
	description: `List directory contents. Returns entries sorted alphabetically, with "/" suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Prefer this over \`bash ls\` for file exploration.`,
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list. Defaults to the orchestrator cwd." })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of entries to return. Defaults to ${DEFAULT_LIMIT}.` }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
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
				return { kind: "ok", output: "(empty directory)" };
			}

			const truncation = truncateHead(outputEntries.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			const notices: string[] = [];
			const details: { truncation?: TruncationResult; entryLimitReached?: number } = {};
			if (entryLimitReached) {
				notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
				details.entryLimitReached = limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
			return {
				kind: "ok",
				output,
				...(Object.keys(details).length > 0 ? { details } : {}),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}
	},
};
