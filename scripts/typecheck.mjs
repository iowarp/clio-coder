#!/usr/bin/env node
// `pnpm run typecheck`: checks source, tests and scripts with `tsrs --fast`,
// the Rust port of the TypeScript 7 checker. Where tsrs cannot run (no native
// package for this platform, such as win32-arm64; an install without optional
// dependencies; or a crash) it says so on stderr and checks with TypeScript's
// own `tsc`, so the command never fails for packaging reasons.
//
//   node scripts/typecheck.mjs [extra compiler flags; -p <project> replaces tsconfig.tests.json]
//
// CLIO_TYPECHECK=tsc forces the reference compiler. The exit code is the
// checker's: 0 clean; tsrs exits 2 and tsc exits 1 on type errors.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "package.json"));

/** The tsrs native binary, or the reason it is unavailable. */
export async function resolveTsrs() {
	if (process.env.TSRS_BIN) {
		return existsSync(process.env.TSRS_BIN)
			? { path: process.env.TSRS_BIN }
			: { reason: `TSRS_BIN=${process.env.TSRS_BIN} does not exist` };
	}
	try {
		const directory = dirname(require.resolve("tsrs/package.json"));
		const { default: getExePath } = await import(pathToFileURL(join(directory, "lib", "getExePath.js")).href);
		return { path: getExePath() };
	} catch (error) {
		return { reason: String(error?.message ?? error).split("\n")[0] };
	}
}

/** The reference `tsc`, run through this Node: `@typescript/native`, the TypeScript 7 compiler. */
export function resolveTsc() {
	return join(dirname(require.resolve("@typescript/native/package.json")), "bin", "tsc");
}

/** The TypeScript release tsrs ports, from its package metadata. */
export function tsrsTypescriptVersion() {
	return require("tsrs/package.json").tsrs.typescriptVersion;
}

export function runTsc(args, options = {}) {
	return spawnSync(process.execPath, [resolveTsc(), ...args], { cwd: root, ...options });
}

// tsrs exits 0 clean, 1 or 2 on diagnostics; anything else (a panic exits 101) is a crash, not a verdict.
export const tsrsVerdict = (result) => !result.error && result.signal === null && [0, 1, 2].includes(result.status);

async function main() {
	const extra = process.argv.slice(2);
	const project = extra.some((arg) => arg === "-p" || arg === "--project")
		? []
		: ["-p", join(root, "tsconfig.tests.json")];
	let reason;
	if (process.env.CLIO_TYPECHECK === "tsc") reason = "CLIO_TYPECHECK=tsc";
	else {
		const tsrs = await resolveTsrs();
		if (tsrs.path) {
			const result = spawnSync(tsrs.path, [...project, "--fast", ...extra], { stdio: "inherit" });
			if (tsrsVerdict(result)) return result.status;
			reason = result.error
				? `tsrs failed to start: ${result.error.message}`
				: `tsrs crashed (${result.signal ?? `exit ${result.status}`})`;
		} else reason = tsrs.reason;
	}
	process.stderr.write(`typecheck: using tsc, the slower reference compiler, because ${reason}.\n`);
	const result = runTsc([...project, ...extra], { cwd: process.cwd(), stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`typecheck: ${error.message}\n`);
			process.exitCode = 1;
		},
	);
}
