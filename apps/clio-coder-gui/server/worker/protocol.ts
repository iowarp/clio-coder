import type { Static } from "typebox";
import type { Problem } from "../../contracts/common.js";
import type { DocsRequest } from "../../contracts/docs.js";
import type { EvidenceRequest } from "../../contracts/evidence.js";
import type { FleetRequest } from "../../contracts/fleet.js";
import type { LibraryPlanRequest } from "../../contracts/library.js";
import type { EvalRequest } from "../../contracts/reports.js";
import type { SettingWrite } from "../../contracts/settings-controls.js";
import type { Tool } from "../../contracts/toolchain.js";
import type { TraceRequest } from "../../contracts/traces.js";

export type WorkerKind = "reads" | "ops";
export type WorkerSettings = {
	fixture?: boolean;
	fixtureDocsPackageRoot?: string;
	fixtureGraphDelayMs?: number;
	readDelayMs?: number;
	readDeadlineMs?: number;
	readLanes?: number;
	installDelayMs?: number;
	failInstall?: boolean;
	crashRead?: boolean;
};
export type RawTool = Tool;
export type RuntimeInfo = { entry: string; packageRoot: string; execArgv: string[]; threadId: number };
export interface Methods {
	"runtime.info": { params: Record<string, never>; result: RuntimeInfo };
	"system.read": { params: Record<string, never>; result: unknown };
	"interop.read": { params: { cwd: string; probe: boolean }; result: unknown };
	"library.read": { params: { cwd: string; kind: "inventory" | "extensions" }; result: unknown };
	"evals.read": { params: EvalRequest; result: unknown };
	"evidence.read": { params: EvidenceRequest; result: unknown };
	"fleet.read": { params: FleetRequest; result: unknown };
	"settings.read": { params: { cwd: string }; result: unknown };
	"targets.runtimes": { params: Record<string, never>; result: unknown };
	"settings.controls": { params: { cwd: string }; result: unknown };
	"settings.write": { params: { cwd: string; write: SettingWrite }; result: unknown };
	"config.graph": { params: { cwd: string }; result: unknown };
	"docs.read": { params: DocsRequest; result: unknown };
	"sessions.list": { params: { cwd: string }; result: unknown };
	"traces.read": { params: TraceRequest; result: unknown };
	"tools.list": { params: Record<string, never>; result: { rows: RawTool[]; threadId: number } };
	"tools.install": { params: { id: string; force: boolean }; result: { id: string; message: string } };
	"library.plan": { params: { cwd: string; request: Static<typeof LibraryPlanRequest> }; result: unknown };
	"library.apply": { params: { cwd: string; planId: string }; result: unknown };
	"library.release": { params: { cwd: string; planId: string }; result: unknown };
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
