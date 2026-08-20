import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const monitorToolSurface = {
	name: ToolNames.Monitor,
	description:
		"Inspect known dispatched runs. Parent-model mid-run observation requires detach:true because ordinary dispatch auto-waits. wait observes without collecting. collect is the authoritative terminal batch operation; collect detached runs before final synthesis. receipt exposes stored evidence. Receipt integrity, evidence verification, briefing provenance, and project-context provenance are separate fields.",
	parameters: Type.Object({
		run_id: Type.Optional(
			Type.String({ description: "Run id from dispatch output or monitor list; omit with mode=list." }),
		),
		mode: Type.Optional(
			StringEnum(["status", "peek", "receipt", "list", "wait", "collect", "tools"], {
				description:
					"What to return. Defaults to status when run_id is present and list when it is absent. status, peek, receipt, tools, and wait each observe one run and require a run_id; list takes none. tools answers what a run executed: its tool calls with outcomes, plus per-tool totals from the receipt.",
			}),
		),
		batch_id: Type.Optional(Type.String({ description: "Detached batch id from dispatch detach:true (mode=collect)." })),
		run_ids: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Explicit run ids for mode=collect; a one-element array is also accepted by single-run modes when run_id is absent.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Number({
				description:
					"mode=wait: max ms to block (default 60000, capped at 600000); mode=collect never blocks and ignores this value with a notice.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
