import { defineCommandSpec, type LeafFlagsSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["configure"],
	summary: "interactive first-run/configuration wizard",
	hidden: false,
});

/**
 * The flags `configure` parses (its own help and argument loop in `src/cli/configure.ts`), for `help --json`.
 * `--api-key` stores the key in the credential store under the target id; `--api-key-env` saves the variable's name
 * on the target (SPEC 6.4, review R08).
 */
export const leafFlags: ReadonlyArray<LeafFlagsSpec> = [
	{
		path: ["configure"],
		flags: [
			{ name: "--quick", value: "boolean" },
			{ name: "--settings", value: "boolean" },
			{ name: "--section", value: "string" },
			{ name: "--json", value: "boolean" },
			{ name: "--edit", value: "boolean" },
			{ name: "--interop", value: "boolean" },
			{ name: "--import", value: "string" },
			{ name: "--yes", value: "boolean" },
			{ name: "--replace", value: "boolean" },
			{ name: "--list", value: "boolean" },
			{ name: "--all", value: "boolean" },
			{ name: "--id", value: "string" },
			{ name: "--runtime", value: "string" },
			{ name: "--url", value: "string" },
			{ name: "--model", value: "string" },
			{ name: "--orchestrator-model", value: "string" },
			{ name: "--background-model", value: "string" },
			{ name: "--fleet-model", value: "string", conflicts: ["--agent-profile"] },
			{ name: "--agent-profile", value: "string" },
			{ name: "--agent-profile-model", value: "string" },
			{ name: "--bind-agent", value: "string" },
			{ name: "--api-key-env", value: "string", placement: "leaf", persistence: "persisted" },
			{ name: "--api-key", value: "string", placement: "leaf", persistence: "persisted" },
			{ name: "--force", value: "boolean" },
			{ name: "--gateway", value: "boolean" },
			{ name: "--lifecycle", value: ["user-managed", "clio-coder-managed"] },
			{ name: "--set-orchestrator", value: "boolean" },
			{ name: "--verify", value: "boolean" },
			{ name: "--no-verify", value: "boolean" },
			{ name: "--set-background", value: "boolean" },
			{ name: "--set-fleet-default", value: "boolean" },
			{ name: "--context-window", value: "number" },
			{ name: "--max-tokens", value: "number" },
			{ name: "--reasoning", value: ["true", "false"] },
		],
	},
];
