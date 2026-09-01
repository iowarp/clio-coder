const SENSITIVE_KEY = /(?:^|[_-])(api[_-]?key|authorization|cookie|password|secret|token)(?:$|[_-])/i;

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
	[/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
	[/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
	[/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted]"],
	[/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted]"],
	[/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
	[/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"',}]+/gi, "$1[redacted]"],
];

export function redactArtifactForStorage<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
	return redactValue(value, env) as T;
}

function redactValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
	if (typeof value === "string") return redactString(value, env);
	if (Array.isArray(value)) return value.map((entry) => redactValue(entry, env));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(entry, env);
		}
		return out;
	}
	return value;
}

function redactString(value: string, env: NodeJS.ProcessEnv): string {
	let out = stripHomePrefix(value, env.HOME);
	for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

function stripHomePrefix(value: string, home: string | undefined): string {
	if (home === undefined || home.length === 0) return value;
	const normalized = home.replace(/\/+$/g, "");
	if (normalized.length === 0) return value;
	return value.split(normalized).join("$HOME");
}
