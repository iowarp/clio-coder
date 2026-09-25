/** Five-row block lettering, following the visual style of the Warpio CLI wordmark. */
const LETTERS: Record<string, readonly string[]> = {
	C: [" ████", "██   ", "██   ", "██   ", " ████"],
	L: ["██   ", "██   ", "██   ", "██   ", "█████"],
	I: ["███", " █ ", " █ ", " █ ", "███"],
	O: [" ███ ", "██ ██", "██ ██", "██ ██", " ███ "],
	D: ["████ ", "██ ██", "██ ██", "██ ██", "████ "],
	E: ["█████", "██   ", "████ ", "██   ", "█████"],
	R: ["████ ", "██ ██", "████ ", "██ ██", "██ ██"],
};

const WIDE_LETTERS: Record<string, readonly string[]> = {
	C: [" ██████", "██     ", "██     ", "██     ", " ██████"],
	L: ["██     ", "██     ", "██     ", "██     ", "███████"],
	I: ["██", "██", "██", "██", "██"],
	O: [" ██████ ", "██    ██", "██    ██", "██    ██", " ██████ "],
	D: ["██████ ", "██   ██", "██   ██", "██   ██", "██████ "],
	E: ["███████", "██     ", "█████  ", "██     ", "███████"],
	R: ["██████ ", "██   ██", "██████ ", "██   ██", "██   ██"],
	" ": [" ", " ", " ", " ", " "],
};
function stacked(font: Record<string, readonly string[]>): string[] {
	const word = (text: string) =>
		Array.from({ length: 5 }, (_, row) => [...text].map((letter) => font[letter]?.[row] ?? "").join(" "));
	const clio = word("CLIO");
	const coder = word("CODER");
	const width = coder[0]?.length ?? 0;
	return [
		...clio.map((line) => line.padStart(line.length + Math.floor((width - line.length) / 2)).padEnd(width)),
		" ".repeat(width),
		...coder,
	];
}

/** First row after CLIO. */
export const WELCOME_WORDMARK_SPLIT = 5;
export const WELCOME_WORDMARK = stacked(LETTERS);
export const WELCOME_WORDMARK_WIDE = stacked(WIDE_LETTERS);
