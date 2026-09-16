import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolSurface } from "./lazy-tool.js";

export const webFetchToolSurface = {
	name: ToolNames.WebFetch,
	description:
		"Fetch an http(s) URL; HTML is cleaned and converted to Markdown. Non-2xx responses are errors. Non-GET/HEAD methods or any body require outward-action approval; private networks require operator opt-in.",
	parameters: Type.Object({
		url: Type.String({ description: "Fully-qualified http(s) URL." }),
		method: Type.Optional(Type.String({ description: "HTTP method (default GET)." })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers." })),
		body: Type.Optional(Type.String({ description: "Request body (POST/PUT)." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (default 30000)." })),
		max_bytes: Type.Optional(Type.Number({ description: "Max bytes returned (default 600000)." })),
		format: Type.Optional(
			Type.String({ description: "auto (default) converts HTML to Markdown; raw returns the body unconverted." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;

/**
 * The read half of the web split. It shares web_fetch's implementation and
 * accepts no method, headers, or body, so no argument can turn it into an
 * outward action: it is read class unconditionally and never asks for an
 * outward approval.
 */
export const webReadToolSurface = {
	name: ToolNames.WebRead,
	description:
		"Read an http(s) URL with a GET request; HTML is cleaned and converted to Markdown, arXiv and repository-tree URLs are summarized. Sends nothing outward: no method, headers, or body. Non-2xx responses are errors; private networks require operator opt-in.",
	parameters: Type.Object({
		url: Type.String({ description: "Fully-qualified http(s) URL." }),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (default 30000)." })),
		max_bytes: Type.Optional(Type.Number({ description: "Max bytes returned (default 600000)." })),
		format: Type.Optional(
			Type.String({ description: "auto (default) converts HTML to Markdown; raw returns the body unconverted." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
