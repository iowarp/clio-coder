/** Shared command types; this leaf never loads the interactive runtime. */
export type ReloadClass = "settings" | "library" | "extensions";
export type ReloadTarget = ReloadClass | "all";

export interface ReloadReport {
	text: string;
	failed: boolean;
}

export interface ReloadClassesController {
	readonly active: boolean;
	captureIssue(message: string): boolean;
	/** Records the hook generation line of the extension commit this report triggered. */
	captureExtensionCommit(line: string): boolean;
	run(
		target: ReloadTarget,
		reloadOperators: () => Promise<{
			status: string;
			message: string;
			failures: string[];
			nextSession: string[];
		}>,
	): Promise<ReloadReport>;
}
