import { getVersionInfo } from "../domains/lifecycle/version.js";

export function runVersionCommand(): number {
	const v = getVersionInfo();
	process.stdout.write(`Clio Coder ${v.clio}\n`);
	return 0;
}
