import { writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const ALLOWED_BASENAME = "PLAN.md";

export const writePlanTool: ToolSpec = {
	name: ToolNames.WritePlan,
	description:
		"Write a planning document to PLAN.md at the project root. Any other path is rejected. This is the advise-mode terminal action.",
	parameters: Type.Object({
		content: Type.String({ description: "Full plan contents in Markdown. Must be non-empty." }),
		path: Type.Optional(Type.Literal(ALLOWED_BASENAME, { description: 'Must be "PLAN.md" at the project root.' })),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const rawPath = typeof args.path === "string" ? args.path : ALLOWED_BASENAME;
		const content = typeof args.content === "string" ? args.content : "";
		const projectRoot = path.resolve(process.cwd());
		const expected = path.join(projectRoot, ALLOWED_BASENAME);
		const resolved = path.resolve(projectRoot, rawPath);
		if (resolved !== expected) {
			return {
				kind: "error",
				message: `write_plan only accepts path="${ALLOWED_BASENAME}" at the project root; got ${rawPath}`,
			};
		}
		if (content.length === 0) {
			return { kind: "error", message: "write_plan: empty content" };
		}
		try {
			writeFileSync(expected, content, "utf8");
			// write_plan is advise-mode only (see src/tools/bootstrap.ts). Writing
			// PLAN.md is the whole turn; set `terminate: true` so pi-agent-core
			// skips the follow-up LLM call that would otherwise summarize what
			// was just written.
			return {
				kind: "ok",
				output: `wrote ${Buffer.byteLength(content, "utf8")}B to ${ALLOWED_BASENAME}`,
				terminate: true,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write_plan: ${msg}` };
		}
	},
};
