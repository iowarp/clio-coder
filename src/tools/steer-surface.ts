import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const steerToolSurface = {
	name: ToolNames.Steer,
	description:
		"Guide or cancel a running native worker by run id. Only a detached run can be steered from here, because an ordinary dispatch auto-waits; ACP runs have no input channel.",
	parameters: Type.Object({
		run_id: Type.String({ description: "Run id from dispatch output or monitor list." }),
		action: StringEnum(["guide", "cancel"], { description: "What to do." }),
		message: Type.Optional(Type.String({ description: "action=guide: the steering message." })),
	}),
	baseActionClass: "dispatch",
	executionMode: "sequential",
} satisfies ToolSurface;
