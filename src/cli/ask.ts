import type { createInterface } from "node:readline/promises";

type QuestionReader = Pick<ReturnType<typeof createInterface>, "question"> & {
	interactive?: boolean;
	text?: (label: string, initial?: string) => Promise<string>;
	choose?: (label: string, choices: ReadonlyArray<string>, current: string) => Promise<string>;
};

export async function ask(rl: QuestionReader, label: string, defaultValue?: string): Promise<string | null> {
	if (rl.text) return rl.text(label, defaultValue);
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

export async function askYesNo(rl: QuestionReader, label: string, defaultValue: boolean): Promise<boolean> {
	if (rl.choose && rl.interactive) return (await rl.choose(label, ["yes", "no"], defaultValue ? "yes" : "no")) === "yes";
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
