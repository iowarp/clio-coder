/**
 * Model-authored text reaches the terminal as rows. Every C0 control except
 * newline, tab and carriage return (which the renderers lay out), DEL and C1
 * controls show as `\u{1b}` text, the form the approval surfaces use, so no
 * escape sequence a model writes can drive the operator's terminal. Each byte
 * maps on its own, so a sequence split across stream deltas is caught too.
 * Display only: the ledger and the provider keep the text as written.
 */
export function escapeTerminalControls(text: string): string {
	let out = "";
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const control = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
		if (!control) continue;
		out += `${text.slice(start, index)}\\u{${code.toString(16)}}`;
		start = index + 1;
	}
	return start === 0 ? text : out + text.slice(start);
}
