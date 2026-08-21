import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const BROWSER_MODES = ["auto", "required", "off"] as const;

/** Tolerate the weak-model shape of `args` sent as a JSON string. */
export function prepareVerifyArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	if (typeof next.args === "string") {
		try {
			const parsed = JSON.parse(next.args) as unknown;
			if (Array.isArray(parsed)) next.args = parsed;
		} catch {
			// Leave the malformed string; runScriptCheck ignores non-arrays.
		}
	}
	return next;
}

export const verifyToolSurface = {
	name: ToolNames.Verify,
	description:
		'Run a declared verification check: no arguments lists package scripts and .clio-coder/verifiers.yaml entries, check=<id> runs one, and check="frontend" with path validates an HTML/CSS/JS artifact.',
	parameters: Type.Object({
		check: Type.Optional(
			Type.String({
				description: `Declared project check ID, package script (${VERIFICATION_SCRIPT_FAMILY_HINT}), or "frontend". Omit to list available checks.`,
			}),
		),
		path: Type.Optional(Type.String({ description: "check=frontend: artifact file under the workspace root." })),
		args: Type.Optional(
			Type.Array(Type.String(), { description: "Package scripts only: extra arguments passed after --." }),
		),
		browser: Type.Optional(
			StringEnum(BROWSER_MODES, { description: "check=frontend: headless browser mode (default auto)." }),
		),
		cwd: Type.Optional(Type.String({ description: "Package-script working directory; ignored by project checks." })),
		timeout_ms: Type.Optional(
			Type.Number({ description: "Package/frontend timeout in ms; project checks use their declared timeoutMs." }),
		),
		max_output_bytes: Type.Optional(Type.Number({ description: "Output cap in bytes (default 600000)." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	prepareArguments: prepareVerifyArguments,
} satisfies ToolSurface;
