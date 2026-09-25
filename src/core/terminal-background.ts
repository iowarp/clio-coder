import type { ThemeBackground } from "./theme-token-hex.js";

/**
 * Which background the terminal paints, so the theme can pick the palette
 * drawn for it. Resolution order: the CLIO_CODER_THEME override, the answer to
 * the startup OSC 11 query, COLORFGBG, then unknown, which selects the
 * mid-luminance palette that reads on either background.
 *
 * A leaf with no interactive imports: src/cli/clio.ts probes before the
 * terminal lease loads, and the theme reads the result when it is created.
 */

let probed: ThemeBackground | null = null;

export function terminalBackground(env: NodeJS.ProcessEnv = process.env): ThemeBackground | null {
	const forced = (env.CLIO_CODER_THEME ?? "").trim().toLowerCase();
	if (forced === "dark" || forced === "light") return forced;
	if (forced === "neutral") return null;
	return probed ?? backgroundFromColorFgBg(env.COLORFGBG);
}

/** COLORFGBG is `fg;bg` (rxvt, Konsole, some iTerm2 profiles); bg 7 and 9-15 are light. */
export function backgroundFromColorFgBg(value: string | undefined): ThemeBackground | null {
	const last = value?.split(";").at(-1);
	if (last === undefined || !/^\d+$/u.test(last)) return null;
	const index = Number(last);
	if (index > 15) return null;
	return index === 7 || index >= 9 ? "light" : "dark";
}

/** Parse an OSC 11 reply, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` with 1-4 hex digits per channel. */
export function backgroundFromOsc11(reply: string): ThemeBackground | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal replies are escape sequences.
	const match = /\u001b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/iu.exec(reply);
	if (match === null) return null;
	const channel = (hex: string | undefined): number => {
		const text = hex ?? "0";
		const value = Number.parseInt(text, 16) / (16 ** text.length - 1);
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	const luminance = 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
	// Mid gray (#777) sits near 0.18; dark themes land far below and light far above.
	return luminance > 0.18 ? "light" : "dark";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal replies are escape sequences.
const OSC11_REPLY = /\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal replies are escape sequences.
const DA1_REPLY = /\u001b\[\?[\d;]*c/gu;

/**
 * Ask the terminal for its background before anything else owns stdin. The
 * OSC 11 query is followed by DA1, which every terminal answers, so a terminal
 * that ignores OSC 11 costs one round trip rather than the timeout. Bytes that
 * are not one of the two replies, such as keys typed during the probe, are
 * handed back to stdin for the editor.
 */
export async function probeTerminalBackground(
	options: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ThemeBackground | null> {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const env = options.env ?? process.env;
	const forced = (env.CLIO_CODER_THEME ?? "").trim().toLowerCase();
	if (forced === "dark" || forced === "light" || forced === "neutral") return terminalBackground(env);
	const noColor = env.NO_COLOR;
	if ((typeof noColor === "string" && noColor.length > 0) || !stdin.isTTY || !stdout.isTTY) return null;
	const wasRaw = stdin.isRaw;
	let buffer = "";
	const reply = await new Promise<string>((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			stdin.off("data", onData);
			resolve(buffer);
		};
		const onData = (chunk: Buffer | string): void => {
			buffer += chunk.toString();
			if (DA1_REPLY.test(buffer)) finish();
			DA1_REPLY.lastIndex = 0;
		};
		const timer = setTimeout(finish, options.timeoutMs ?? 200);
		stdin.setRawMode(true);
		stdin.on("data", onData);
		stdin.resume();
		stdout.write("\u001b]11;?\u0007\u001b[c");
	});
	stdin.pause();
	stdin.setRawMode(wasRaw);
	const rest = reply.replace(OSC11_REPLY, "").replace(DA1_REPLY, "");
	if (rest.length > 0) stdin.unshift(Buffer.from(rest));
	probed = backgroundFromOsc11(reply);
	return terminalBackground(env);
}
