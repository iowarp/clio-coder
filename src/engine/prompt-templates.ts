import { parseCommandArgs, substituteArgs as substituteParsedArgs } from "@earendil-works/pi-agent-core";

export { parseCommandArgs };

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
