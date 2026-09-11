import type { Problem } from "../../contracts/common.js";
import type { BlueprintFile, DocsRequest } from "../../contracts/docs.js";
import type { Tool } from "../../contracts/toolchain.js";
import type { TraceRequest } from "../../contracts/traces.js";

export type WorkerKind = "reads" | "ops";
export type WorkerSettings = {
	fixture?: boolean;
	fixtureDocsPackageRoot?: string;
	readDelayMs?: number;
	readDeadlineMs?: number;
	installDelayMs?: number;
	failInstall?: boolean;
	crashRead?: boolean;
};
export type RawTool = Tool;
export interface Methods {
	"docs.read": { params: DocsRequest; result: unknown };
	"docs.blueprint": { params: { path: string }; result: BlueprintFile };
	"sessions.list": { params: { cwd: string }; result: unknown };
	"traces.read": { params: TraceRequest; result: unknown };
	"tools.list": { params: Record<string, never>; result: { rows: RawTool[]; threadId: number } };
	"tools.install": { params: { id: string; force: boolean }; result: { id: string; message: string } };
	"tools.remove": { params: { id: string }; result: { id: string; message: string } };
}
export type Method = keyof Methods;
export type Call = {
	[M in Method]: { id: string; method: M; params: Methods[M]["params"]; deadlineMs: number };
}[Method];
export type Reply =
	| { id: string; ok: true; result: Methods[Method]["result"] }
	| { id: string; ok: false; problem: Problem }
	| { id: string; progress: string };
