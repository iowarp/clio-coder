import { getVersionInfo } from "../domains/lifecycle/version.js";

export function runVersionCommand(): number {
	const v = getVersionInfo();
	const lines = [
		`clio ${v.clio}`,
		`node ${v.node}`,
		`platform ${v.platform}`,
		`pi-agent-core ${v.piAgentCore ?? "(missing)"}`,
		`pi-ai ${v.piAi ?? "(missing)"}`,
		`pi-tui ${v.piTui ?? "(missing)"}`,
	];
	process.stdout.write(lines.join("\n") + "\n");
	return 0;
}
