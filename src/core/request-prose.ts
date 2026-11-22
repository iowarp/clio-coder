/** Fenced examples (including an unfinished fence) are not instructions from the operator. */
export function requestProse(text: string): string {
	if (!text.includes("```") && !text.includes("~~~")) return text;
	let fence: string | undefined;
	return text
		.split(/\r?\n/u)
		.filter((line) => {
			const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/u.exec(line);
			if (fence !== undefined) {
				if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim()) fence = undefined;
				return false;
			}
			fence = marker?.[1];
			return fence === undefined;
		})
		.join("\n");
}
