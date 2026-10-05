import type { JobRecord } from "../core/job-types.js";
import type { ToolResult } from "./registry.js";

export type JobView = JobRecord;

/** Parent host port shared by slash commands, ACP and monitor (#411). */
export interface JobOperations {
	invoke(args: Record<string, unknown>, options?: { sessionId?: string }): Promise<ToolResult>;
	list(): readonly JobView[];
	status(id: string): JobView | null;
	subscribe(listener: (view: JobView) => void): () => void;
}
