import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolSurface } from "./lazy-tool.js";

export const webFetchToolSurface = {
	name: ToolNames.WebFetch,
	description: "Fetch an http(s) URL; HTML is cleaned and converted to Markdown. Non-2xx responses are errors.",
	parameters: Type.Object({
		url: Type.String({ description: "Fully-qualified http(s) URL." }),
		method: Type.Optional(Type.String({ description: "HTTP method (default GET)." })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers." })),
		body: Type.Optional(Type.String({ description: "Request body (POST/PUT)." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (default 30000)." })),
		max_bytes: Type.Optional(Type.Number({ description: "Max bytes returned (default 600000)." })),
		format: Type.Optional(
			Type.String({
				description: "auto (default: HTML is cleaned to Markdown, other content passes through) or raw (no conversion).",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
