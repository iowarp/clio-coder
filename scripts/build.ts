import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { buildColor, buildVerbose } from "./build-output.js";

// Loading through tsx keeps tsup from writing a temporary bundled config into
// the checkout. Build and watch share the same entry and asset policy.
if (process.argv.includes("--build-worker")) {
	const [{ build }, { default: config }] = await Promise.all([import("tsup"), import("../tsup.config.js")]);
	if (typeof config === "function" || Array.isArray(config)) throw new Error("Expected one root build configuration.");
	await build({ ...config, config: false, ...(process.argv.includes("--watch") ? { watch: true } : {}) });
} else {
	const verbose = buildVerbose() || process.argv.includes("--watch");
	const color = buildColor();
	// tsup's silent option also drops warnings. Capture its ordinary output in
	// a child so failures can replay every diagnostic without replacing stdout.
	const child = spawn(
		process.execPath,
		[...process.execArgv, import.meta.filename, ...process.argv.slice(2), "--build-worker"],
		{
			stdio: verbose ? "inherit" : ["inherit", "pipe", "pipe"],
			env: { ...process.env, ...(!color ? { NO_COLOR: "1", FORCE_COLOR: "0" } : { FORCE_COLOR: "1" }) },
		},
	);
	let transcript = "";
	let pending = "";
	const present = (text: string): string => (color ? text : stripVTControlCharacters(text));
	const emit = (line: string): void => {
		const plain = stripVTControlCharacters(line).trimEnd();
		// Only recognized informational lines are omitted; warnings and unfamiliar output stay visible.
		if (/^CLI (?:Building entry:|Using tsconfig:|Using tsup config:|tsup v|Target:|Cleaning output folder)/u.test(plain))
			return;
		if (/^ESM (?:Build start$|⚡️? Build success in \d+ms$|dist\/\S+\s+[\d.]+ [KMGT]?B$)/u.test(plain)) return;
		process.stdout.write(present(line));
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		transcript += text;
		pending += text;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			emit(pending.slice(0, newline + 1));
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		transcript += text;
		process.stderr.write(present(text));
	});
	const forwardInterrupt = (): void => {
		child.kill("SIGINT");
	};
	const forwardTermination = (): void => {
		child.kill("SIGTERM");
	};
	process.on("SIGINT", forwardInterrupt);
	process.on("SIGTERM", forwardTermination);
	const code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolve(exitCode ?? (signal === "SIGINT" ? 130 : 1)));
	}).finally(() => {
		process.off("SIGINT", forwardInterrupt);
		process.off("SIGTERM", forwardTermination);
	});
	if (pending) emit(pending);
	if (code !== 0 && !verbose && transcript) process.stderr.write(present(transcript));
	process.exitCode = code;
}
