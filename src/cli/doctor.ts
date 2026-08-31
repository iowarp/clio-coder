import {
	formatDoctorReport,
	isUninitializedHome,
	runDoctor,
	runDoctorFleetChecks,
	runDoctorInteropChecks,
	runDoctorModelChecks,
	runDoctorRuntimeChecks,
} from "../domains/lifecycle/doctor.js";
import { stateStorageFinding } from "./doctor-state-size.js";
import { toolchainFindings } from "./doctor-toolchain.js";
import { printError } from "./shared.js";

const HELP = `clio-coder doctor [--fix] [--json]

Diagnose Clio Coder state without creating files. On a home Clio has never
written to, doctor says so in one row and exits 0. Use --fix to repair structure:
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
	// Decided before runDoctor so a --fix run, which initializes the home, still
	// gets every check on the home it just built.
	const untouched = !fix && isUninitializedHome();
	const findings = runDoctor({ fix });
	const storageChecks = untouched ? [] : [stateStorageFinding()];
	const runtimeChecks = await runDoctorRuntimeChecks();
	// Every model pointer is checked against what its target advertises, so a
	// placeholder id saved by configure is reported here and not on the first turn.
	const modelChecks = await runDoctorModelChecks();
	// The interop and fleet sweeps read the state and config roots through the
	// ensuring accessors, which create them, and there is no fleet or interop
	// state to inspect before Clio has ever written anything. On a home Clio has
	// never touched, doctor keeps its promise to create nothing.
	const interopChecks = untouched ? [] : await runDoctorInteropChecks();
	// Fleet preflight probes each configured node over SSH and persists the
	// per-node eligibility verdicts dispatch placement enforces.
	const fleetChecks = untouched ? [] : await runDoctorFleetChecks();
	// Resolution reads PATH and the vendor root and creates nothing, but on an
	// untouched home there is no vendor root to look at and the answer would be
	// "none" for every row regardless, so the sweep stays with the others.
	const toolChecks = untouched ? [] : toolchainFindings();
	const all = [
		...findings,
		...storageChecks,
		...runtimeChecks,
		...modelChecks,
		...interopChecks,
		...fleetChecks,
		...toolChecks,
	];
	const ok = all.every((f) => f.ok);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok, fix, findings: all }, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatDoctorReport(all)}\n`);
	}
	return ok ? 0 : 1;
}
