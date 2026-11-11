export interface ReplayTask {
	id: string;
	kind: "replay";
	at: string;
	prompt: string;
	key: string[];
}
export interface HandbookScore {
	score: number;
	recall: number | null;
	rules: number;
	chars: number;
	invalid: { rule: string; paths: string[] }[];
	duplicates: [string, string][];
	staleRuleIds: { id: string; current: string | null }[];
	contradicted: { rule: string; facts: string[] }[];
	workerCoverage: number | null;
}
export function replayTask(commit: string, message: string, files: ReadonlyArray<string>): ReplayTask | null;
export function scoreReplay(key: ReadonlyArray<string>, touched: ReadonlyArray<string>): number;
export function scoreHandbook(input: { handbook: string; reference?: string; tree: string }): Promise<HandbookScore>;
export function unsafeEnvironment(env: Record<string, string | undefined>, home?: string): string | null;
