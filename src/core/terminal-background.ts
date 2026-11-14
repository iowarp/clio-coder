import { colorDisabled } from "./terminal-preferences.js";
import { type Rgb, relativeLuminance, type ThemeBackground } from "./theme-token-hex.js";

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

/** True when CLIO_CODER_THEME decides the palette, so terminal reports change nothing. */
export function terminalThemeForced(env: NodeJS.ProcessEnv = process.env): boolean {
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
	return terminalThemeForced(env) ? null : reportedColor;
}

/**
 * What a launcher tells the session it starts in a pane about the real terminal. Both are true only for that one
 * start, so the session forgets them once read and the pane's shell is started without them.
 */
export const TERMINAL_HANDOVER_VARS = ["CLIO_CODER_TERMINAL_BACKGROUND", "CLIO_CODER_TERMINAL_SIZE"] as const;

/** The reported color and the terminal's size, as the variables for the session a launcher starts in a pane. */
export function terminalHandover(
	stdout: Pick<NodeJS.WriteStream, "columns" | "rows"> = process.stdout,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const handed: Record<string, string> = {};
	const color = terminalBackgroundColor(env);
	if (color !== null) {
		handed.CLIO_CODER_TERMINAL_BACKGROUND = color.map((channel) => channel.toString(16).padStart(2, "0")).join("");
	}
	if (stdout.columns > 0 && stdout.rows > 0) handed.CLIO_CODER_TERMINAL_SIZE = `${stdout.columns}x${stdout.rows}`;
	return handed;
}

/** How much of the terminal a pane host's own chrome may take from its one pane. */
const HOST_CHROME = { columns: 12, rows: 6 } as const;

/**
 * A session its launcher starts in a pane is running before the host's client has attached, and until then the
 * pane has the host's default size, not the terminal's. A first frame laid out for that size was on screen for 14
 * to 60 ms before the one at the real size replaced it. The launcher hands over the terminal's size, and the first
 * frame waits for the pane to come within the host's chrome of it. The wait is bounded: a host that never resizes
 * the pane gets its frame anyway.
 */
export async function awaitHandedTerminalSize(
	options: { stdout?: NodeJS.WriteStream; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
	const stdout = options.stdout ?? process.stdout;
	const env = options.env ?? process.env;
	const handed = /^(\d+)x(\d+)$/u.exec(env.CLIO_CODER_TERMINAL_SIZE ?? "");
	Reflect.deleteProperty(env, "CLIO_CODER_TERMINAL_SIZE");
	if (handed === null || !stdout.isTTY) return;
	const columns = Number(handed[1]);
	const rows = Number(handed[2]);
	const attached = (): boolean =>
		stdout.columns <= columns &&
		stdout.columns >= columns - HOST_CHROME.columns &&
		stdout.rows <= rows &&
		stdout.rows >= rows - HOST_CHROME.rows;
	if (attached()) return;
	await new Promise<void>((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			stdout.off("resize", onResize);
			resolve();
		};
		const onResize = (): void => {
			if (attached()) finish();
		};
		const timer = setTimeout(finish, options.timeoutMs ?? 1_000);
		stdout.on("resize", onResize);
	});
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
export function reportTerminalColors(report: {
	background?: Rgb | undefined;
	scheme?: ThemeBackground | undefined;
}): boolean {
	const color =
		report.background ?? (report.scheme === undefined || report.scheme === reportedScheme ? reportedColor : null);
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
function colorFromOsc11(reply: string): Rgb | null {
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
	// A pane host has no background to report until a client attaches, and a session its launcher starts is up
	// before that. The launcher asked the real terminal and handed the answer over.
	const handed = /^[0-9a-f]{6}$/iu.exec(env.CLIO_CODER_TERMINAL_BACKGROUND ?? "")?.[0];
	// Read once: a restarted session and every child asks the terminal for itself.
	Reflect.deleteProperty(env, "CLIO_CODER_TERMINAL_BACKGROUND");
	if (terminalThemeForced(env)) return terminalBackground(env);
	if (colorDisabled(env) || !stdin.isTTY || !stdout.isTTY) return null;
	if (handed !== undefined) {
		const channel = (at: number): number => Number.parseInt(handed.slice(at, at + 2), 16);
		reportTerminalColors({ background: [channel(0), channel(2), channel(4)] });
		return terminalBackground(env);
	}
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
