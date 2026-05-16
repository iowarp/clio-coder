import { stdin as input, stdout as output } from "node:process";
import type { Interface } from "node:readline/promises";

import type { OAuthSelectPrompt } from "../engine/oauth.js";

function writeOAuthSelectOptions(prompt: OAuthSelectPrompt): string | undefined {
	const defaultId = prompt.options[0]?.id;
	process.stdout.write(`${prompt.message}\n`);
	for (const [index, option] of prompt.options.entries()) {
		const marker = option.id === defaultId ? "*" : " ";
		process.stdout.write(`  ${marker} ${String(index + 1).padStart(2)}. ${option.label} (${option.id})\n`);
	}
	process.stdout.write("\n");
	return defaultId;
}

export async function promptOAuthSelection(
	rl: Pick<Interface, "question">,
	prompt: OAuthSelectPrompt,
): Promise<string | undefined> {
	const defaultId = writeOAuthSelectOptions(prompt);
	if (!defaultId) return undefined;
	if (!input.isTTY || !output.isTTY) return defaultId;
	const ids = new Set(prompt.options.map((option) => option.id));
	for (;;) {
		const answer = (await rl.question(`Selection (number or id, q to cancel) [${defaultId}]: `)).trim();
		if (answer.length === 0) return defaultId;
		if (answer === "q" || answer === "quit" || answer === "cancel") return undefined;
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
			return prompt.options[numeric - 1]?.id;
		}
		if (ids.has(answer)) return answer;
		process.stderr.write(`unknown selection: ${answer}\n`);
	}
}
