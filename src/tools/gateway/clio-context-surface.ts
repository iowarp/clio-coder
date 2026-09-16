import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

/**
 * Immutable surfaces of the two Clio-internal reads that left the permanent
 * `context` schema: `clio_docs` (bundled documentation) and `clio_library`
 * (the recipe catalog). The implementations load on first call.
 */

export const clioDocsToolSurface = {
	name: ToolNames.ClioDocs,
	description:
		"Search Clio's bundled documentation for a question or terms and return cited sections as JSON; omit query to list the corpus (files and counts). Read-only; charges the per-turn observation pool.",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "Question or terms; omit to list the corpus." })),
		limit: Type.Optional(Type.Number({ description: "Max sections (default 5, max 12)." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;

export const clioLibraryToolSurface = {
	name: ToolNames.ClioLibrary,
	description:
		"Read the recipe catalog: installed skills, agents, prompts, and fleets with their owner and invocation, plus installable packages. Body-free rows, bounded pages; activates and installs nothing. Unavailable inside a worker.",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "Name, owner, or description terms." })),
		kind: Type.Optional(
			StringEnum(["skill", "agent", "prompt", "fleet", "plugin"], {
				description: "One recipe kind, or plugin for installable package rows.",
			}),
		),
		ref: Type.Optional(Type.String({ description: "Exact kind:name or resource key for one record." })),
		limit: Type.Optional(Type.Number({ description: "Max rows (default 20, max 50)." })),
		offset: Type.Optional(Type.Number({ description: "Zero-based offset; follow nextOffset (default 0)." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
