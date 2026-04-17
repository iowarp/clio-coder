import { formatDoctorReport, runDoctor } from "../domains/lifecycle/doctor.js";

export function runDoctorCommand(): number {
	const findings = runDoctor();
	process.stdout.write(formatDoctorReport(findings) + "\n");
	return findings.every((f) => f.ok) ? 0 : 1;
}
