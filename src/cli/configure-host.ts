import { PassThrough, Writable } from "node:stream";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { runOnboardingWizard } from "./configure-onboarding.js";
import type { SelectOptions, SelectResult, TextPromptOptions, TextResult } from "./select.js";

/** #385: the CLI owns the steps; a host supplies prompts without taking stdin. */
export interface ConfigureWizardHost {
	select<T>(options: SelectOptions<T>): Promise<SelectResult<T>>;
	text(options: TextPromptOptions): Promise<TextResult>;
	report(line: string): void;
	clearMessages(): void;
	cancelled(): boolean;
	readonly signal: AbortSignal;
	dismissPrompt(): void;
	/** Called only after the shared wizard commits the target settings. */
	onTargetSaved?(): void;
	/** What the wizard is waiting on with no prompt up, in words; null drops back to the host's own wait row. */
	waiting?(label: string | null): void;
	/** Open a sign-in link in the operator's browser, best effort; the link is reported as well. */
	openUrl?(url: string): void;
	/**
	 * A wait the operator may stop without leaving the wizard, such as a browser
	 * sign-in: the host's Esc calls `stop`, and the step that started the wait
	 * asks its question again. Null when the wait ends.
	 */
	stoppableWait?(stop: (() => void) | null): void;
}

const UNWRAPPED_COLUMNS = 100_000;

export type HostedTargetOptions = { mode: "first" | "add" } | { mode: "edit"; target: TargetDescriptor };

/** Loaded on target setup so the instant shell never evaluates wizard code. */
export async function runHostedTargetWizard(host: ConfigureWizardHost, options: HostedTargetOptions): Promise<number> {
	let pending = "";
	const output = new Writable({
		write(chunk, _encoding, done) {
			pending += String(chunk);
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) host.report(line.trim());
			done();
		},
	});
	// The surface wraps to its own width. Left to the presenter's 80 columns, one failure arrived as
	// several reports, and a 40-column dock got them wrapped twice.
	Object.defineProperty(output, "columns", { value: UNWRAPPED_COLUMNS });
	const input = new PassThrough();
	try {
		return await runOnboardingWizard({ in: input, out: output }, options, host);
	} finally {
		input.destroy();
		output.destroy();
	}
}
