// Derived from pi-coding-agent packages/coding-agent/src/core/prompt-templates.ts at v1.0.0 (MIT license).
/** Parse bash-style quoted arguments. Unquoted whitespace of any kind, including newlines, separates arguments. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

const PLACEHOLDER = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

/**
 * Substitute `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`, `${ARGUMENTS:-default}`, `${@:N}` and
 * `${@:N:L}` in one pass over the template, so values that contain placeholder-like text are never expanded again.
 * `rawArguments` is the exact text after the command. When given, `$ARGUMENTS` inserts it byte for byte
 * instead of the re-joined parsed arguments.
 */
export function substituteArgs(content: string, args: string[], rawArguments?: string): string {
	const allArgs = args.join(" ");
	const exactArgs = rawArguments ?? allArgs;
	return content.replace(
		PLACEHOLDER,
		(_match: string, target?: string, fallback?: string, from?: string, count?: string, simple?: string) => {
			if (target !== undefined) {
				const value =
					target === "ARGUMENTS" ? (args.length > 0 ? exactArgs : "") : target === "@" ? allArgs : args[Number(target) - 1];
				return value || (fallback ?? "");
			}
			if (from !== undefined) {
				const start = Math.max(Number(from) - 1, 0);
				return args.slice(start, count === undefined ? undefined : start + Number(count)).join(" ");
			}
			if (simple === "ARGUMENTS") return exactArgs;
			if (simple === "@") return allArgs;
			return args[Number(simple) - 1] ?? "";
		},
	);
}
