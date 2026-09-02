import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const monitorToolSurface = {
	name: ToolNames.Monitor,
	description:
		"Inspect dispatched runs: list enumerates them; status, peek, receipt, and tools observe one run; wait blocks on one run without collecting; collect is the terminal operation for a detached batch or run list, required before final synthesis.",
	parameters: Type.Object({
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
			Type.Number({ description: "mode=wait: max ms to block (default 60000, max 600000); collect never blocks." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
