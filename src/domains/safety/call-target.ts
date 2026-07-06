/**
 * Operator-facing description of what a parked tool call will touch. Shared
 * by the interactive approval overlay (main-agent asks, which hold the call
 * in-process) and the worker runtime (escalations, which must carry the
 * description across the NDJSON stdout seam because the args never leave the
 * worker). Both sides sanitize here so a hostile command string cannot style
 * or spoof the UI that approves it.
 */

const ESC_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
// Built through the constructor so no control character appears in a regex
// literal. OSC sequences terminate on BEL, ST (ESC backslash), or end of
// input; CSI sequences are parameter bytes then one final byte.
const OSC_PATTERN = new RegExp(`${ESC_CHAR}\\][\\s\\S]*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\|$)`, "g");
const CSI_PATTERN = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[0-9A-Za-z]`, "g");

function sanitizeForDisplay(value: string): string {
	const stripped = value.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
	let out = "";
	for (const ch of stripped) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : ch;
	}
	return out;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Neutralize escape sequences and control bytes in a pre-composed target
 * string and collapse it to one line. Used where a description crosses a
 * trust boundary (worker stdout) before it reaches the overlay.
 */
export function sanitizeCallTargetText(value: string): string {
	return oneLine(sanitizeForDisplay(value));
}

/**
 * Derive the operator-facing object of a call for the approval overlay: the
 * command for bash, a path for file tools, else a compact args preview.
 * Returns an empty string when nothing meaningful is derivable, so callers
 * can omit the Target row instead of rendering a blank.
 */
export function describeCallTarget(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const str = (value: unknown): string | null =>
		typeof value === "string" && value.trim().length > 0 ? oneLine(sanitizeForDisplay(value)).trim() || null : null;
	const candidate = str(args.command) ?? str(args.path) ?? str(args.file_path) ?? str(args.name) ?? str(args.pattern);
	if (candidate) return candidate;
	try {
		const json = JSON.stringify(args);
		return json === "{}" || json === undefined ? "" : oneLine(sanitizeForDisplay(json)).slice(0, 120);
	} catch {
		return "";
	}
}
