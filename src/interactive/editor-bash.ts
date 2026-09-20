export interface EditorBashCommand {
	command: string;
	excludeFromContext: boolean;
}

/**
 * Invisible one-shot envelope used only between ClioEditor and its submit
 * callback. Pi trims submitted text before invoking that callback, so a
 * whitespace guard would disappear and re-arm a pasted `!` command. The
 * controller removes this envelope before routing the text as an ordinary
 * prompt; it is never persisted or sent to a model.
 */
export const PASTED_EDITOR_OPERATOR_GUARD = "\u2063";

export function guardPastedEditorOperator(text: string): string {
	return `${PASTED_EDITOR_OPERATOR_GUARD}${text}`;
}

export function unguardPastedEditorOperator(text: string): string {
	return text.startsWith(PASTED_EDITOR_OPERATOR_GUARD) ? text.slice(PASTED_EDITOR_OPERATOR_GUARD.length) : text;
}

export function parseEditorBashCommand(text: string): EditorBashCommand | null {
	// Commands are an editor-line operator, not a shell-script paste surface.
	// The paste guard also makes a bracketed-pasted one-liner literal until it
	// has crossed the editor submit boundary and been routed as a normal prompt.
	if (text.startsWith(PASTED_EDITOR_OPERATOR_GUARD) || text.includes("\n") || text.includes("\r")) return null;
	if (!text.startsWith("!")) return null;
	const excludeFromContext = text.startsWith("!!");
	const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim();
	if (command.length === 0) return null;
	return { command, excludeFromContext };
}
