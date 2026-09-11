import { parseArgs } from "node:util";

export function serverOptions(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string", default: "0" },
			fixture: { type: "boolean", default: false },
			open: { type: "boolean", default: false },
			"idle-exit": { type: "string" },
			token: { type: "string" },
			"log-file": { type: "string" },
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
	return {
		port: integer("port", values.port, 0, 65535),
		idleMs: values["idle-exit"] === undefined ? undefined : integer("idle-exit", values["idle-exit"], 1, 2_147_483_647),
		fixture: values.fixture,
		open: values.open,
		token: values.token,
		logFile: values["log-file"],
	};
}
