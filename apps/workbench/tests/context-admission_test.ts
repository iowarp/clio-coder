import { deepStrictEqual } from "node:assert/strict";
import { AcpRemoteError } from "../acp-client.ts";
import { failureProjection } from "../clio-host.ts";

Deno.test("context refusal explains the blocked request instead of an empty turn", () => {
	const error = new AcpRemoteError("session/prompt", -32000, {
		version: 1,
		code: "prompt_not_admitted",
		reason: "context-window-exceeded",
	});
	deepStrictEqual(failureProjection(error, null), {
		code: "clio-coder-admission-context-window-exceeded",
		summary:
			"Clio Coder could not fit this request in the model's context window. Reduce the input or active context, or choose a larger context window.",
		source: "reported-by-clio",
	});
});
