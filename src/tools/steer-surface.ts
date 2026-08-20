import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const steerToolSurface = {
	name: ToolNames.Steer,
	description:
		"Control a running native worker whose run id is already available. Parent-model mid-run control requires detach:true because ordinary dispatch auto-waits and dispatch/steer are sequential; the interactive operator/TUI may steer an active synchronous native run through the dispatch contract. ACP runs have no input channel.",
	parameters: Type.Object({
		run_id: Type.String({ description: "Run id from dispatch output or monitor list." }),
		action: StringEnum(["guide", "cancel"], { description: "What to do." }),
		message: Type.Optional(Type.String({ description: "action=guide: the steering message." })),
	}),
	baseActionClass: "dispatch",
	executionMode: "sequential",
} satisfies ToolSurface;
