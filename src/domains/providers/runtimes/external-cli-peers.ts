import { createExternalCliRuntime } from "./external-cli-descriptor.js";

export const piCliRuntime = createExternalCliRuntime({
	id: "pi-cli",
	displayName: "Pi CLI — managed headless delegation",
	binaryName: "pi",
	defaultModel: "pi-cli-default",
	headlessCommand: "pi --print --mode json --no-session",
	outputParser: "pi-jsonl",
	authNotice: "Uses the installed `pi` command and its own configured provider login.",
	provider: "pi-cli",
});

export const opencodeCliRuntime = createExternalCliRuntime({
	id: "opencode-cli",
	displayName: "OpenCode CLI — managed headless delegation",
	binaryName: "opencode",
	defaultModel: "opencode-cli-default",
	headlessCommand: "opencode run --format json",
	outputParser: "opencode-run-jsonl",
	authNotice: "Uses the installed `opencode` command and its own configured provider login.",
	provider: "opencode-cli",
});
