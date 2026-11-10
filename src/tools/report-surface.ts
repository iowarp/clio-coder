import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { REPORT_AREAS, REPORT_KINDS } from "../domains/report/vocabulary.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

export const reportToolSurface = {
	name: ToolNames.Report,
	description:
		'Draft a report about Clio Coder itself for the operator to review, or ask the operator once whether to draft one. action="draft" saves the draft and puts it in front of the operator; the harness adds versions and what it recorded. action="offer" asks first, and the host may refuse. This tool never sends anything.',
	parameters: Type.Object({
		action: StringEnum(["offer", "draft"], { description: "offer asks the operator once; draft writes the report." }),
		kind: StringEnum([...REPORT_KINDS], { description: "What kind of report." }),
		title: Type.String({ description: "One line naming the problem." }),
		happened: Type.String({ description: "What happened, plainly, in your words." }),
		operator_words: Type.Optional(Type.String({ description: "The operator's own sentence about it, verbatim." })),
		expected: Type.Optional(Type.String({ description: "What should have happened." })),
		reproduce: Type.Optional(Type.String({ description: "Only steps that were actually run." })),
		not_known: Type.Array(Type.String(), {
			description: "Everything you did not verify. Required; may be empty.",
		}),
		area: Type.Optional(StringEnum([...REPORT_AREAS], { description: "The part of Clio Coder it concerns." })),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
