import { resolve } from "node:path";
import { scaffoldExtension } from "../domains/extensions/authoring/scaffold.js";
import { testExtensionPackage } from "../domains/extensions/authoring/test-runner.js";
import { validateExtensionPackage } from "../domains/extensions/authoring/validate.js";
import { printError } from "./shared.js";

const HELP = `clio-coder extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
clio-coder extensions validate <path> [--json]
clio-coder extensions test <path>
`;

export async function runExtensionsAuthoring(argv: ReadonlyArray<string>): Promise<number> {
	const [command, ...args] = argv;
	let positional: string | undefined;
	let template: string | undefined;
	let dir: string | undefined;
	let json = false;
	try {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--help" || arg === "-h") {
				process.stdout.write(HELP);
				return 0;
			}
			if (arg === "--json" && command === "validate" && !json) {
				json = true;
				continue;
			}
			if (command === "init" && (arg === "--template" || arg === "--dir")) {
				const value = args[++index];
				if (!value || value.startsWith("-") || (arg === "--template" ? template !== undefined : dir !== undefined))
					throw new Error(`invalid ${arg}`);
				if (arg === "--template") template = value;
				else dir = value;
				continue;
			}
			if (!arg || arg.startsWith("-") || positional) throw new Error(`unexpected argument: ${arg}`);
			positional = arg;
		}
		if (!positional || !["init", "validate", "test"].includes(command ?? ""))
			throw new Error("a package id or path is required");
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	try {
		if (command === "init") {
			const path = scaffoldExtension(positional, {
				...(template === undefined ? {} : { template }),
				...(dir === undefined ? {} : { dir }),
			});
			process.stdout.write(
				`Created ${positional} (${template ?? "status"}) at ${path}\nNext: clio-coder extensions validate ${path}\nThen: clio-coder extensions test ${path}\n`,
			);
			return 0;
		}
		if (command === "test") return await testExtensionPackage(resolve(positional));
		const report = await validateExtensionPackage(positional);
		if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		else {
			process.stdout.write(`${report.valid ? "Valid" : "Invalid"}: ${report.path}\n`);
			for (const diagnostic of report.diagnostics)
				process.stdout.write(
					`${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}\n`,
				);
			if (report.envelope)
				process.stdout.write(
					`Capability envelope (operator consent):\n${JSON.stringify(report.envelope, null, 2)}\nSHA-256: ${report.envelopeDigest}\n`,
				);
			process.stdout.write(
				`Registration check: ${report.registration.status}${report.registration.reason ? ` (${report.registration.reason})` : ""}\n${report.registration.notice}\n`,
			);
		}
		return report.valid ? 0 : 1;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
