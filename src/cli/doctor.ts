import { formatDoctorReport, runDoctor } from "../domains/lifecycle/doctor.js";
import { printError } from "./shared.js";

const HELP = `clio doctor [--fix]

Diagnose Clio state without creating files. Use --fix to create or repair missing state.
`;

export function runDoctorCommand(args: ReadonlyArray<string> = []): number {
	const fix = args.includes("--fix");
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const unknown = args.find((arg) => arg !== "--fix");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stdout.write(HELP);
		return 2;
	}
	const findings = runDoctor({ fix });
	process.stdout.write(`${formatDoctorReport(findings)}\n`);
	return findings.every((f) => f.ok) ? 0 : 1;
}
