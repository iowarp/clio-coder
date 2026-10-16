/**
 * The `--var key=value` arguments of every playbook command. `fleet run`,
 * `playbook validate` and `playbook graph` read them through this one parser,
 * so a playbook that validates with a set of variables is the one that runs
 * with them.
 */
export function parsePlaybookVars(args: ReadonlyArray<string>): {
	vars: Record<string, string>;
	rest: string[];
	error?: string;
} {
	const vars: Record<string, string> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg !== "--var") {
			if (arg !== undefined) rest.push(arg);
			continue;
		}
		const pair = args[i + 1];
		i += 1;
		if (pair === undefined || !pair.includes("=")) return { vars, rest, error: "--var requires key=value" };
		const eq = pair.indexOf("=");
		const key = pair.slice(0, eq).trim();
		if (key.length === 0) return { vars, rest, error: "--var requires a non-empty key" };
		vars[key] = pair.slice(eq + 1);
	}
	return { vars, rest };
}

/** Undefined without any `--var`, so a preflight renders nothing it was not given. */
export function playbookVarsOrUndefined(vars: Readonly<Record<string, string>>): Record<string, string> | undefined {
	return Object.keys(vars).length === 0 ? undefined : { ...vars };
}
