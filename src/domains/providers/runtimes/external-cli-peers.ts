import { createExternalCliRuntime } from "./external-cli-descriptor.js";

export const piCliRuntime = createExternalCliRuntime({
	id: "pi-cli",
	displayName: "Pi CLI (managed headless)",
	binaryName: "pi",
	defaultModel: "pi-cli-default",
	headlessCommand: "pi --print --mode json --no-session",
	outputParser: "pi-jsonl",
	authNotice: "Uses the installed `pi` command and its own configured provider login.",
	provider: "pi-cli",
	// `--no-context-files` stops Pi reading them.
	repositoryInstructions: { files: ["AGENTS.md"], fallback: ["CLAUDE.md"], delivery: "single-source" },
});

export const opencodeCliRuntime = createExternalCliRuntime({
	id: "opencode-cli",
	displayName: "OpenCode CLI (managed headless)",
	binaryName: "opencode",
	defaultModel: "opencode-cli-default",
	headlessCommand: "opencode run --format json",
	outputParser: "opencode-run-jsonl",
	authNotice: "Uses the installed `opencode` command and its own configured provider login.",
	provider: "opencode-cli",
	// OpenCode run has no switch that skips them. It reads the first of these names found from its directory up,
	// in every directory that has it (opencode 1.18 `Instruction.systemPaths`).
	repositoryInstructions: {
		files: ["AGENTS.md"],
		fallback: ["CLAUDE.md", "CONTEXT.md"],
		oneName: true,
		delivery: "overlay",
	},
});
