/**
 * The Node majors a release is qualified on and where to find each one. A leaf module: the
 * preflight and qualification both read it, and qualification runs the preflight.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUALIFIED_MAJORS = ["24", "22"];

/** The Node binary for one major: an explicit path, this process, or the newest nvm install. */
export function nodeBinary(major, explicit) {
	const binary = explicit ?? (process.versions.node.split(".")[0] === major ? process.execPath : nvmNode(major));
	if (!binary) throw new Error(`Qualification needs Node ${major}; pass --node${major} <path to node>.`);
	const version = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: "pipe" }).trim();
	if (!version.startsWith(`v${major}.`)) throw new Error(`${binary} is ${version}, not Node ${major}.`);
	return binary;
}

function nvmNode(major) {
	const base = join(homedir(), ".nvm", "versions", "node");
	if (!existsSync(base)) return undefined;
	const numeric = (name) => name.slice(1).split(".").map(Number);
	const newest = readdirSync(base)
		.filter((name) => name.startsWith(`v${major}.`))
		.sort((a, b) => {
			const [x, y] = [numeric(a), numeric(b)];
			return y[1] - x[1] || y[2] - x[2];
		})[0];
	return newest === undefined ? undefined : join(base, newest, "bin", "node");
}
