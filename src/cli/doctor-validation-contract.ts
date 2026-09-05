import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { describeValidationContract, loadValidationContract } from "../domains/safety/validation-contract.js";

/**
 * One row for the workspace's scientific validation contract: absent, parsed
 * (and so raising the rigor default to high), Markdown-only advisory, or
 * invalid with the parse fault. Reads the workspace root only; creates nothing.
 */
export function validationContractFinding(workspaceRoot = process.cwd()): DoctorFinding {
	const name = "validation contract";
	const loaded = loadValidationContract(workspaceRoot);
	if (!loaded.ok) {
		return { ok: false, name, detail: `invalid: ${describeValidationContract(loaded)}; rigor default stays normal` };
	}
	if (loaded.contract === null) {
		if ("advisory" in loaded) {
			return { ok: true, name, level: "warn", detail: `markdown-only: ${describeValidationContract(loaded)}` };
		}
		return { ok: true, name, detail: "none at the workspace root; rigor default normal" };
	}
	const artifacts = loaded.contract.artifacts?.length ?? 0;
	const validators = loaded.contract.validators?.length ?? 0;
	return {
		ok: true,
		name,
		detail: `valid: ${loaded.path} (version ${loaded.contract.version}, ${artifacts} artifact(s), ${validators} validator(s)); rigor default high`,
	};
}
