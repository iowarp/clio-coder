import {
	formatDoctorReport,
	runDoctor,
	runDoctorFleetChecks,
	runDoctorRuntimeChecks,
} from "../domains/lifecycle/doctor.js";
import { printError } from "./shared.js";

const HELP = `clio doctor [--fix] [--json]

Diagnose Clio Coder state without creating files. Use --fix to repair structure:
missing directories, missing template files, and credential permissions.
Settings are validated directly against the current schema.
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
		process.stderr.write(HELP);
		return 2;
	}
	const findings = runDoctor({ fix });
	const runtimeChecks = await runDoctorRuntimeChecks();
	// Fleet preflight probes each configured node over SSH and persists the
	// per-node eligibility verdicts dispatch placement enforces.
	const fleetChecks = await runDoctorFleetChecks();
	const all = [...findings, ...runtimeChecks, ...fleetChecks];
	const ok = all.every((f) => f.ok);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok, fix, findings: all }, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatDoctorReport(all)}\n`);
	}
	return ok ? 0 : 1;
}
