import { repairJson } from "@earendil-works/pi-ai";

const RECEIVED_DELIMITER = "\n\nReceived arguments:\n";
const EXCERPT_CHARS = 40;

/** Pi parses the repaired text, so its position runs ahead of the received text by one for each raw tab or newline. */
function receivedOffset(received: string, repairedOffset: number): number {
	let low = 0;
	let high = received.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (repairJson(received.slice(0, middle)).length < repairedOffset) low = middle + 1;
		else high = middle;
	}
	return low;
}

function faultLines(parseError: string, received: string): string[] {
	const position = /^(.*?) in JSON at position (\d+)/su.exec(parseError);
	if (position === null) {
		const ended = parseError.startsWith("Unexpected end");
		return [`What failed: ${parseError}.`, ...(ended ? ["The arguments ended before the JSON did."] : [])];
	}
	const offset = receivedOffset(received, Number(position[2]));
	const start = Math.max(0, offset - EXCERPT_CHARS);
	const excerpt = `${received.slice(start, offset)}<<<HERE>>>${received.slice(offset, offset + EXCERPT_CHARS)}`;
	const lines = [`What failed: ${position[1]}, at character ${offset} of the arguments:`, excerpt];
	if (position[1]?.startsWith("Unterminated string")) {
		lines.push("A string value never closed, so the arguments ended inside it.");
	} else if (received.slice(0, offset).trimEnd().endsWith('"')) {
		lines.push('A string value ended at the " just before HERE. If that quote belongs to the text, write it as \\".');
	}
	return lines;
}

/**
 * Turn Pi's parse failure into a refusal the model can act on. Pi says only
 * that a position failed, and for tab-led text that position is wrong against
 * the echoed text, so a Haiku edit spent about 3 rounds finding the fault. The
 * call stays refused: an unescaped quote leaves no lossless reading of where a
 * value ends, so the arguments are never guessed at. Repair has already dealt
 * with raw control characters and bad escapes, so the fault is never those.
 */
export function explainToolArgumentsError(argumentsError: string): string {
	const split = argumentsError.indexOf(RECEIVED_DELIMITER);
	if (split < 0) return argumentsError;
	const parseError = argumentsError.slice(0, split);
	const received = argumentsError.slice(split + RECEIVED_DELIMITER.length);
	return [
		"the arguments are not valid JSON, so the call did not run and nothing changed.",
		...faultLines(parseError, received),
		'How to send it: repeat the same call with the same values, as one JSON object rather than a string or array. Inside a string write a double quote as \\", a backslash as \\\\, a newline as \\n and a tab as \\t. Tabs and newlines did not cause this failure.',
	]
		.join("\n")
		.concat(RECEIVED_DELIMITER, received);
}
