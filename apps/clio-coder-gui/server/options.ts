import { parseArgs } from "node:util";

export function serverOptions(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string" },
			fixture: { type: "boolean", default: false },
			open: { type: "boolean", default: false },
			"no-open": { type: "boolean", default: false },
			"idle-exit": { type: "string" },
			token: { type: "string" },
			"log-file": { type: "string" },
			persistent: { type: "string" },
			path: { type: "string" },
			"reuse-background": { type: "boolean", default: false },
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
	const path = values.path ?? "/";
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		throw new Error("--path must be an absolute path within the app.");
	}
	if (
		!path.startsWith("/") ||
		decoded.startsWith("//") ||
		/[\\?#]/.test(decoded) ||
		[...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
		decoded.split("/").some((part) => part === "." || part === "..") ||
		new URL(path, "http://clio.invalid").pathname !== path
	)
		throw new Error("--path must be an absolute path within the app.");
	if (
		values["reuse-background"] &&
		(values.port !== undefined ||
			values.token !== undefined ||
			values.fixture ||
			values.persistent !== undefined ||
			values["idle-exit"] !== undefined ||
			values["log-file"] !== undefined)
	)
		throw new Error("--reuse-background cannot be combined with foreground server configuration flags.");
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
		open: values.open && !values["no-open"],
		token: values.token,
		logFile: values["log-file"],
		persistent: values.persistent,
		path,
		reuseBackground: values["reuse-background"],
	};
}
