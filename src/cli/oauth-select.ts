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

/** `browser` or `device` from `auth login --method`; otherwise the session decides. */
export type OAuthMethodPreference = "browser" | "device";

export const NO_LOCAL_BROWSER_LINE = "No local browser in this session, so sign in on any device:";

/**
 * Answers a provider's login-method list without asking: the browser method where a browser can open, else the
 * device-code or copy-code method. Returns undefined for any other list, which still goes to the operator.
 */
export function chooseOAuthMethod(prompt: OAuthSelectPrompt, preference: OAuthMethodPreference): string | undefined {
	const ids = prompt.options.map((option) => option.id);
	if (!ids.includes("browser")) return undefined;
	if (preference === "browser") return "browser";
	return ids.find((id) => id !== "browser") ?? "browser";
}

/**
 * The lines shown with an authorization URL. "A browser window should open" from a provider is kept only when Clio
 * launched one; without one, a localhost callback needs its port forwarded from the machine holding the browser.
 */
export function oauthUrlLines(url: string, instructions: string | undefined, opened: boolean): string[] {
	const lines = opened ? ["Opening your browser...", `If it does not open, visit: ${url}`] : [`Open: ${url}`];
	const kept = opened ? instructions : instructions?.replace(/A browser window should open\.\s*/i, "").trim();
	if (kept) lines.push(kept);
	if (!opened) {
		let port: string | undefined;
		try {
			const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
			if (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1") port = redirect.port;
		} catch {
			// No loopback redirect: the provider shows a code to paste instead.
		}
		if (port)
			lines.push(
				`If your browser is on another machine, forward the callback first: ssh -L ${port}:localhost:${port} <this host>`,
			);
	}
	return lines;
}

/** A sign-in error, saying when the provider could not be reached and through which proxy. */
export function describeOAuthError(error: unknown, proxy: string | null): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message)) return message;
	return `could not reach the sign-in service (${message}); ${proxy ? `proxy in effect: ${proxy}` : "no proxy is set"}`;
}
