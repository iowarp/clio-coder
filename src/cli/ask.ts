import type { createInterface } from "node:readline/promises";

export async function ask(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue?: string,
): Promise<string | null> {
	const suffix = defaultValue && defaultValue.length > 0 ? ` [${defaultValue}]` : "";
	try {
		const answer = (await rl.question(`${label}${suffix}: `)).trim();
		if (answer.length === 0) return defaultValue ?? "";
		if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return null;
		return answer;
	} catch {
		return null;
	}
}

export async function askYesNo(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue: boolean,
): Promise<boolean> {
	const marker = defaultValue ? "Y/n" : "y/N";
	for (;;) {
		const answer = await ask(rl, `${label} [${marker}]`);
		if (answer === null) return defaultValue;
		if (answer.length === 0) return defaultValue;
		const lc = answer.toLowerCase();
		if (lc === "y" || lc === "yes") return true;
		if (lc === "n" || lc === "no") return false;
		process.stderr.write(`invalid response: ${answer}\n`);
	}
}
