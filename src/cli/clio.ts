import { bootOrchestrator } from "../entry/orchestrator.js";

export async function runClioCommand(): Promise<number> {
	const result = await bootOrchestrator();
	return result.exitCode;
}
