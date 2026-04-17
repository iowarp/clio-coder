export interface FleetStep {
	recipeId: string;
	options: Readonly<Record<string, string>>;
}

export interface Fleet {
	steps: ReadonlyArray<FleetStep>;
}

function isWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(input: string, index: number): number {
	let cursor = index;
	while (cursor < input.length && isWhitespace(input[cursor])) {
		cursor += 1;
	}
	return cursor;
}

function parseRecipeId(input: string, index: number): { recipeId: string; nextIndex: number } {
	let cursor = index;
	while (cursor < input.length) {
		const char = input[cursor];
		if (char === "[" || char === "]" || char === "," || char === "=" || isWhitespace(char)) {
			break;
		}
		if (char === "-" && input[cursor + 1] === ">") {
			break;
		}
		cursor += 1;
	}

	return {
		recipeId: input.slice(index, cursor),
		nextIndex: cursor,
	};
}

function parseQuotedValue(input: string, index: number): { value: string; nextIndex: number } {
	let cursor = index + 1;
	while (cursor < input.length) {
		const char = input[cursor];
		if (char === "\\") {
			cursor += 2;
			continue;
		}
		if (char === '"') {
			const quoted = input.slice(index, cursor + 1);
			try {
				const value = JSON.parse(quoted);
				if (typeof value !== "string") {
					throw new Error("quoted option value must decode to a string");
				}
				return { value, nextIndex: cursor + 1 };
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`fleet-parser: invalid quoted option value (${reason})`);
			}
		}
		cursor += 1;
	}

	throw new Error(`fleet-parser: unclosed quoted option value at position ${index + 1}`);
}

function parseOptions(input: string, index: number): { options: Record<string, string>; nextIndex: number } {
	const options: Record<string, string> = {};
	let cursor = index + 1;

	while (true) {
		cursor = skipWhitespace(input, cursor);
		if (cursor >= input.length) {
			throw new Error(`fleet-parser: unclosed "[" at position ${index + 1}`);
		}
		if (input[cursor] === "]") {
			return { options, nextIndex: cursor + 1 };
		}

		const keyStart = cursor;
		while (cursor < input.length) {
			const char = input[cursor];
			if (char === "=" || char === "," || char === "]" || isWhitespace(char)) {
				break;
			}
			cursor += 1;
		}
		const key = input.slice(keyStart, cursor);
		if (key === "") {
			throw new Error(`fleet-parser: missing option key at position ${keyStart + 1}`);
		}

		cursor = skipWhitespace(input, cursor);
		if (input[cursor] !== "=") {
			throw new Error(`fleet-parser: expected "=" after option key "${key}"`);
		}
		cursor += 1;
		cursor = skipWhitespace(input, cursor);
		if (cursor >= input.length) {
			throw new Error(`fleet-parser: missing option value for "${key}"`);
		}

		let value: string;
		if (input[cursor] === '"') {
			const parsed = parseQuotedValue(input, cursor);
			value = parsed.value;
			cursor = parsed.nextIndex;
		} else {
			const valueStart = cursor;
			while (cursor < input.length && input[cursor] !== "," && input[cursor] !== "]") {
				cursor += 1;
			}
			value = input.slice(valueStart, cursor).trim();
			if (value === "") {
				throw new Error(`fleet-parser: missing option value for "${key}"`);
			}
		}

		if (Object.hasOwn(options, key)) {
			throw new Error(`fleet-parser: duplicate option key "${key}"`);
		}
		options[key] = value;

		cursor = skipWhitespace(input, cursor);
		if (cursor >= input.length) {
			throw new Error(`fleet-parser: unclosed "[" at position ${index + 1}`);
		}
		if (input[cursor] === ",") {
			cursor += 1;
			continue;
		}
		if (input[cursor] === "]") {
			return { options, nextIndex: cursor + 1 };
		}

		throw new Error(`fleet-parser: expected "," or "]" after option "${key}"`);
	}
}

export function parseFleet(input: string): Fleet {
	if (input.trim() === "") {
		throw new Error("fleet-parser: fleet string is empty");
	}

	const steps: FleetStep[] = [];
	let cursor = 0;
	let justConsumedArrow = false;

	while (true) {
		cursor = skipWhitespace(input, cursor);
		const recipeStart = cursor;
		const parsedRecipe = parseRecipeId(input, cursor);
		const recipeId = parsedRecipe.recipeId.trim();
		if (recipeId === "") {
			if (justConsumedArrow) {
				throw new Error(`fleet-parser: missing recipe after "->" at position ${recipeStart + 1}`);
			}
			throw new Error(`fleet-parser: missing recipe at position ${recipeStart + 1}`);
		}

		cursor = parsedRecipe.nextIndex;
		cursor = skipWhitespace(input, cursor);

		let options: Record<string, string> = {};
		if (input[cursor] === "[") {
			const parsedOptions = parseOptions(input, cursor);
			options = parsedOptions.options;
			cursor = parsedOptions.nextIndex;
		}

		steps.push({ recipeId, options });

		cursor = skipWhitespace(input, cursor);
		if (cursor >= input.length) {
			return { steps };
		}
		if (input.startsWith("->", cursor)) {
			cursor += 2;
			justConsumedArrow = true;
			continue;
		}

		throw new Error(`fleet-parser: expected "->" at position ${cursor + 1}`);
	}
}
