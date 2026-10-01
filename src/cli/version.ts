import { readClioVersionLabel } from "../core/build-info.js";

export function runVersionCommand(): number {
	process.stdout.write(`Clio Coder ${readClioVersionLabel()}\n`);
	return 0;
}
