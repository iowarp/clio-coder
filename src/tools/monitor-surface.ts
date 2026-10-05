import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const monitorToolSurface = {
	name: ToolNames.Monitor,
	description:
		"Inspect dispatched runs and session-owned interval jobs. scope=jobs lists jobs; job_id supports status/wait, including pending match delivery. Jobs expose occurrence evidence and never worker receipts. For worker runs: status, peek, receipt, tools and wait observe; collect settles a detached batch before final synthesis.",
	parameters: Type.Object({
		scope: Type.Optional(StringEnum(["jobs"])),
		job_id: Type.Optional(Type.String({ description: "Conversation-owned job ID; supports status/wait." })),
		run_id: Type.Optional(
			Type.String({ description: "Run id from dispatch output or monitor list; omit with mode=list." }),
		),
		mode: Type.Optional(
			StringEnum(["status", "peek", "receipt", "list", "wait", "collect", "tools"], {
				description:
					"Defaults to status with run_id and list without. tools lists a run's tool calls with outcomes and per-tool totals.",
			}),
		),
		batch_id: Type.Optional(Type.String({ description: "Detached batch id (mode=collect)." })),
		run_ids: Type.Optional(Type.Array(Type.String(), { description: "Run ids to collect (mode=collect)." })),
		timeout_ms: Type.Optional(
			Type.Number({
				description: "Max ms to block: mode=wait default 60000, mode=collect default 30000, max 600000 for both.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
