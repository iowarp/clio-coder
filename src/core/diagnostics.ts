type DiagnosticSink = (text: string, level: "warning" | "error") => void;

const sinks = new Set<DiagnosticSink>();

/** The active terminal owner supplies a renderer; headless processes keep stderr. */
export function installDiagnosticSink(sink: DiagnosticSink): () => void {
	sinks.add(sink);
	return () => {
		sinks.delete(sink);
	};
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
