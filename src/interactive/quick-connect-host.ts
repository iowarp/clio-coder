import { PassThrough, Writable } from "node:stream";
import type { ConfigureWizardHost } from "../cli/configure-host.js";
import { ConfigureNavigation, ConfigurePrompts } from "../cli/configure-prompts.js";
import { runQuickConnect } from "../cli/configure-quick.js";

/** The CLI's Quick Connect questions, asked by the docked wizard surface instead of a terminal. */
class HostedConfigurePrompts extends ConfigurePrompts {
	constructor(
		private readonly host: ConfigureWizardHost,
		output: NodeJS.WritableStream,
	) {
		super(new PassThrough(), output);
	}

	override clearScreen(): void {
		this.host.clearMessages();
	}

	override async text(label: string, initial = "", mask = false): Promise<string> {
		const result = await this.host.text({ heading: label, initial, mask, backLabel: "back" });
		if (result.kind !== "value") throw new ConfigureNavigation(result.kind);
		return result.value;
	}

	override async choose(
		label: string,
		choices: ReadonlyArray<string>,
		current: string,
		searchable = false,
	): Promise<string> {
		const result = await this.host.select({
			heading: label,
			choices: choices.map((value) => ({ value, label: value })),
			initialIndex: Math.max(0, choices.indexOf(current)),
			backLabel: "back",
			...(searchable ? { searchable: true } : {}),
		});
		if (result.kind !== "selected") throw new ConfigureNavigation(result.kind);
		return result.value;
	}
}

/** Loaded on demand so the instant shell never evaluates setup code. 0 when a connection was saved. */
export async function runHostedQuickConnect(host: ConfigureWizardHost): Promise<number> {
	let pending = "";
	// The CLI ends with advice to start Clio from a shell; inside a session it is already running.
	let skipCommand = false;
	const output = new Writable({
		write(chunk, _encoding, done) {
			pending += String(chunk);
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const raw of lines) {
				const line = raw.trim();
				if (!line) continue;
				if (line === "Start Clio:") {
					skipCommand = true;
					continue;
				}
				if (skipCommand && line === "clio-coder") {
					skipCommand = false;
					continue;
				}
				skipCommand = false;
				host.report(line);
			}
			done();
		},
	});
	Object.defineProperty(output, "columns", { value: 100_000 });
	try {
		return (await runQuickConnect(new HostedConfigurePrompts(host, output))) === "connected" ? 0 : 1;
	} finally {
		output.destroy();
	}
}
