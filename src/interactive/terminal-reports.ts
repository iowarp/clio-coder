/**
 * Reports a fullscreen terminal sends on the input stream beside keys.
 *
 * The alternate screen turns on mouse tracking and focus reporting, so pointer
 * movement, clicks, the wheel and window focus arrive as escape sequences the
 * key router would otherwise read as keypresses: a pointer nudge between two
 * Ctrl+C presses cancelled the exit, and quick help, the leader menu and
 * focused overlays reacted to the mouse as if a key had been pressed.
 * String-only so routing can classify a report without a TUI.
 */

export type TerminalReportKind = "pointer" | "focus";

const ESC = String.fromCharCode(27);
// SGR mouse: ESC [ < button ; column ; row, then M (press or motion) or m (release).
const SGR_POINTER = new RegExp(`^${ESC}\\[<\\d+;\\d+;\\d+[Mm]$`);
// Legacy X10 mouse: ESC [ M followed by three encoded bytes.
const X10_POINTER_PREFIX = `${ESC}[M`;
const FOCUS_IN = `${ESC}[I`;
const FOCUS_OUT = `${ESC}[O`;

export function terminalReportKind(data: string): TerminalReportKind | undefined {
	if (data === FOCUS_IN || data === FOCUS_OUT) return "focus";
	if (SGR_POINTER.test(data)) return "pointer";
	if (data.length === 6 && data.startsWith(X10_POINTER_PREFIX)) return "pointer";
	return undefined;
}
