export interface InitialMessageInput {
	messages: ReadonlyArray<string>;
	stdinContent?: string;
	fileText?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	remainingMessages: string[];
}

export async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.length > 0 ? data : undefined);
		});
		process.stdin.resume();
	});
}

export function buildInitialMessage(input: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (input.stdinContent !== undefined) parts.push(input.stdinContent);
	if (input.fileText) parts.push(input.fileText);

	const [first, ...rest] = input.messages;
	if (first !== undefined) parts.push(first);

	const result: InitialMessageResult = { remainingMessages: rest };
	if (parts.length > 0) result.initialMessage = parts.join("");
	return result;
}
