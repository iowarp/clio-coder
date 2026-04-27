import { formatDoctorReport, runDoctor, runDoctorRuntimeChecks } from "../domains/lifecycle/doctor.js";
import { printError } from "./shared.js";

const HELP = `clio doctor [--fix] [--json]

Diagnose Clio Coder state without creating files. Use --fix to create or repair missing state.
Pass --json to emit a machine-readable report on stdout.
`;

export async function runDoctorCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const fix = args.includes("--fix");
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--fix" && arg !== "--json");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stdout.write(HELP);
		return 2;
	}
	const findings = runDoctor({ fix });
	const runtimeChecks = await runDoctorRuntimeChecks();
	const all = [...findings, ...runtimeChecks];
	const ok = all.every((f) => f.ok);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok, fix, findings: all }, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatDoctorReport(all)}\n`);
	}
	return ok ? 0 : 1;
}
