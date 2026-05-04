export type CliOutputMode = "text" | "json" | "rpc";

export interface CliArgDiagnostic {
	type: "warning" | "error";
	message: string;
}

export interface PrintCliArgs {
	print: boolean;
	help: boolean;
	mode: CliOutputMode;
	messages: string[];
	diagnostics: CliArgDiagnostic[];
}

function isMode(value: string): value is CliOutputMode {
	return value === "text" || value === "json" || value === "rpc";
}

export function parsePrintCliArgs(argv: ReadonlyArray<string>): PrintCliArgs {
	const parsed: PrintCliArgs = {
		print: false,
		help: false,
		mode: "text",
		messages: [],
		diagnostics: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--print" || arg === "-p") {
			parsed.print = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--mode") {
			parsed.print = true;
			const value = argv[i + 1];
			if (value === undefined) {
				parsed.diagnostics.push({ type: "error", message: "--mode requires text, json, or rpc" });
				continue;
			}
			i += 1;
			if (!isMode(value)) {
				parsed.diagnostics.push({ type: "error", message: `invalid --mode value: ${value}` });
				continue;
			}
			parsed.mode = value;
			continue;
		}
		if (arg?.startsWith("-")) {
			parsed.diagnostics.push({ type: "error", message: `unknown print-mode option: ${arg}` });
			continue;
		}
		if (arg !== undefined) parsed.messages.push(arg);
	}

	return parsed;
}
