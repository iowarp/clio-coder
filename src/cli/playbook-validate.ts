import { PLAYBOOK_COMMANDS_REMEDY, PlaybookCommandRegistryMissingError } from "../domains/agents/index.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { inspectPlaybook } from "./playbook-preflight.js";
import { parsePlaybookVars, playbookVarsOrUndefined } from "./playbook-vars.js";

export function runPlaybookValidate(args: ReadonlyArray<string>): number {
	const { vars, rest, error } = parsePlaybookVars(args);
	const json = rest.includes("--json");
	const unknown = rest.find((arg, index) => (arg.startsWith("-") && arg !== "--json") || index > 1);
	const name = rest.find((arg) => !arg.startsWith("-"));
	if (name === undefined || unknown !== undefined || error !== undefined) {
		process.stderr.write(
			`clio-coder playbook: validate: ${error !== undefined ? `${error}; ` : ""}usage: clio-coder playbook validate <name> [--var key=value ...] [--json]\n`,
		);
		return 2;
	}
	try {
		const result = inspectPlaybook(name, playbookVarsOrUndefined(vars));
		preflightWriteBoundaries(result.plan, process.cwd());
		if (json)
			process.stdout.write(
				`${JSON.stringify({ valid: true, playbook: name, checks: result.checks, planHash: result.plan.hash }, null, 2)}\n`,
			);
		else for (const check of result.checks) process.stdout.write(`${check.check}: ${check.summary}\n`);
		return 0;
	} catch (error) {
		const raw = error instanceof Error ? error.message : String(error);
		const message = raw.startsWith("unknown agent '") ? `preflight failed: ${raw}` : raw;
		const diagnostics = [
			message,
			...(error instanceof PlaybookCommandRegistryMissingError ? [PLAYBOOK_COMMANDS_REMEDY] : []),
		];
		if (json) process.stdout.write(`${JSON.stringify({ valid: false, playbook: name, diagnostics }, null, 2)}\n`);
		else process.stderr.write(`clio-coder playbook: ${diagnostics.join("\n  ")}\n`);
		return 1;
	}
}
