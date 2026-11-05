type DiagnosticSink = (text: string, level: "warning" | "error") => void;

const sinks = new Set<DiagnosticSink>();

/** The active terminal owner supplies a renderer; headless processes keep stderr. */
export function installDiagnosticSink(sink: DiagnosticSink): () => void {
	sinks.add(sink);
	return () => {
		sinks.delete(sink);
	};
}

/**
 * A fact an interactive owner already renders from the bus in its own words.
 * Headless processes keep it on stderr; with a terminal owner it would be the
 * same fact a second time, in raw form.
 */
export function writeHeadlessDiagnostic(text: string, level: "warning" | "error" = "warning"): void {
	if (sinks.size > 0) return;
	writeDiagnostic(text, level);
}

export function writeDiagnostic(text: string, level: "warning" | "error" = "warning"): void {
	try {
		const sink = [...sinks].at(-1);
		if (sink) sink(text, level);
		else process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
	} catch {
		// Never turn a reporting failure into another diagnostic or a raw TUI write.
	}
}
