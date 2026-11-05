import { colorDisabled } from "./terminal-preferences.js";
import { relativeLuminance, type Rgb, type ThemeBackground } from "./theme-token-hex.js";

/**
 * What the terminal paints behind us, so the theme can solve its palette for it.
 * Resolution order: the CLIO_CODER_THEME override, the last OSC 11 or color
 * scheme report, COLORFGBG, then unknown, which selects the mid-luminance palette
 * that reads on either background. The reported color travels with the scheme,
 * and `terminalColorVersion` moves whenever either changes.
 *
 * A leaf with no interactive imports: src/cli/clio.ts probes before the terminal
 * lease loads, and the interactive shell reports later changes.
 */

let reportedScheme: ThemeBackground | null = null;
let reportedColor: Rgb | null = null;
let version = 0;

function themeIsForced(env: NodeJS.ProcessEnv): boolean {
	const forced = (env.CLIO_CODER_THEME ?? "").trim().toLowerCase();
	return forced === "dark" || forced === "light" || forced === "neutral";
}

export function terminalBackground(env: NodeJS.ProcessEnv = process.env): ThemeBackground | null {
	const forced = (env.CLIO_CODER_THEME ?? "").trim().toLowerCase();
	if (forced === "dark" || forced === "light") return forced;
	if (forced === "neutral") return null;
	return reportedScheme ?? backgroundFromColorFgBg(env.COLORFGBG);
}

/** The color the terminal last reported. A forced theme ignores it, since the operator overruled the terminal. */
export function terminalBackgroundColor(env: NodeJS.ProcessEnv = process.env): Rgb | null {
	return themeIsForced(env) ? null : reportedColor;
}

/** True when CLIO_CODER_THEME decides the palette, so terminal reports change nothing. */
export function terminalThemeForced(env: NodeJS.ProcessEnv = process.env): boolean {
	return themeIsForced(env);
}

/** Moves whenever the reported background changes; caches of painted rows key on it through skinEpoch. */
export function terminalColorVersion(): number {
	return version;
}

/**
 * Record what the terminal said. A color settles the scheme by itself, since a
 * multiplexer can report a scheme for its host that its pane does not paint. A
 * scheme alone drops a remembered color from the other scheme. Returns whether
 * anything changed.
 */
export function reportTerminalColors(report: { background?: Rgb | undefined; scheme?: ThemeBackground | undefined }): boolean {
	const color = report.background ?? (report.scheme === undefined || report.scheme === reportedScheme ? reportedColor : null);
	const scheme = report.background === undefined ? (report.scheme ?? reportedScheme) : schemeOf(report.background);
	const sameColor =
		color === reportedColor ||
		(color !== null && reportedColor !== null && color.every((channel, at) => channel === reportedColor?.[at]));
	if (sameColor && scheme === reportedScheme) return false;
	reportedColor = color;
	reportedScheme = scheme;
	version += 1;
	return true;
}

function schemeOf(rgb: Rgb): ThemeBackground {
	// Mid gray (#777) sits near 0.18; dark themes land far below and light far above.
	return relativeLuminance(rgb) > 0.18 ? "light" : "dark";
}

/** COLORFGBG is `fg;bg` (rxvt, Konsole, some iTerm2 profiles); bg 7 and 9-15 are light. */
export function backgroundFromColorFgBg(value: string | undefined): ThemeBackground | null {
	const last = value?.split(";").at(-1);
	if (last === undefined || !/^\d+$/u.test(last)) return null;
	const index = Number(last);
	if (index > 15) return null;
	return index === 7 || index >= 9 ? "light" : "dark";
}

/** Parse an OSC 11 reply, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` with 1-4 hex digits per channel, to 8-bit channels. */
export function colorFromOsc11(reply: string): Rgb | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal replies are escape sequences.
	const match = /\u001b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/iu.exec(reply);
	if (match === null) return null;
	const channel = (hex: string | undefined): number => {
		const text = hex ?? "0";
		return Math.round((Number.parseInt(text, 16) / (16 ** text.length - 1)) * 255);
	};
	return [channel(match[1]), channel(match[2]), channel(match[3])];
}

export function backgroundFromOsc11(reply: string): ThemeBackground | null {
	const color = colorFromOsc11(reply);
	return color === null ? null : schemeOf(color);
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
	if (themeIsForced(env)) return terminalBackground(env);
	if (colorDisabled(env) || !stdin.isTTY || !stdout.isTTY) return null;
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
	const color = colorFromOsc11(reply);
	if (color !== null) reportTerminalColors({ background: color });
	return terminalBackground(env);
}
