import { parseArgs } from "node:util";

export function serverOptions(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string" },
			fixture: { type: "boolean", default: false },
			open: { type: "boolean", default: false },
			"idle-exit": { type: "string" },
			token: { type: "string" },
			"log-file": { type: "string" },
			persistent: { type: "string" },
		},
	});
	const integer = (name: string, value: string, min: number, max: number) => {
		const number = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
			throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
		return number;
	};
	if (values.token !== undefined && !/^[\w-]{32,256}$/.test(values.token))
		throw new Error("--token must contain 32–256 URL-safe letters, digits, underscores or hyphens.");
	if (values["log-file"] === "") throw new Error("--log-file must name a file.");
	if (
		values.persistent !== undefined &&
		(!values.persistent ||
			values.port !== undefined ||
			values.token !== undefined ||
			values["idle-exit"] !== undefined ||
			values.fixture ||
			values.open)
	)
		throw new Error(
			"--persistent requires a configuration file and cannot be combined with --port, --token, --idle-exit, --fixture or --open.",
		);
	return {
		port: integer("port", values.port ?? "0", 0, 65535),
		idleMs: values["idle-exit"] === undefined ? undefined : integer("idle-exit", values["idle-exit"], 1, 2_147_483_647),
		fixture: values.fixture,
		open: values.open,
		token: values.token,
		logFile: values["log-file"],
		persistent: values.persistent,
	};
}
