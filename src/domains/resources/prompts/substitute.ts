export function parseCommandArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let quote: "'" | '"' | null = null;

	const push = (): void => {
		if (!hasToken) return;
		args.push(current);
		current = "";
		hasToken = false;
	};

	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (!ch) continue;
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'" || ch === `"`) {
			quote = ch;
			hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			push();
			continue;
		}
		current += ch;
		hasToken = true;
	}
	push();

	return args;
}

function sliceArgs(args: ReadonlyArray<string>, startText: string, lengthText: string | undefined): string {
	const start = Number.parseInt(startText, 10);
	if (!Number.isFinite(start) || start <= 0) return "";
	const zeroBased = start - 1;
	if (lengthText === undefined) return args.slice(zeroBased).join(" ");
	const length = Number.parseInt(lengthText, 10);
	if (!Number.isFinite(length) || length <= 0) return "";
	return args.slice(zeroBased, zeroBased + length).join(" ");
}

export function substituteArgs(content: string, args: ReadonlyArray<string>): string {
	const allArgs = args.join(" ");
	return content
		.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, start: string, length: string | undefined) =>
			sliceArgs(args, start, length),
		)
		.replace(/\$ARGUMENTS/g, allArgs)
		.replace(/\$@/g, allArgs)
		.replace(/\$(\d+)/g, (_match, indexText: string) => {
			const index = Number.parseInt(indexText, 10);
			if (!Number.isFinite(index) || index <= 0) return "";
			return args[index - 1] ?? "";
		});
}
