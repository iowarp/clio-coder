// Copied from Pi packages/agent/src/harness/prompt-templates.ts at v0.99.1 (MIT license).
/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: The upstream loop bounds guarantee this character exists.
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
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

/** Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments. */
function substituteParsedArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

const RAW_ARGUMENTS_PLACEHOLDER = /\$ARGUMENTS/g;

/**
 * Substitute prompt arguments while optionally retaining the exact raw text
 * for `$ARGUMENTS`. Positional, slice, and `$@` placeholders keep Pi's
 * shell-style parsing semantics.
 */
export function substituteArgs(content: string, args: string[], rawArguments?: string): string {
	if (rawArguments === undefined) return substituteParsedArgs(content, args);
	return content
		.split(RAW_ARGUMENTS_PLACEHOLDER)
		.map((segment) => substituteParsedArgs(segment, args))
		.join(rawArguments);
}
