import { ToolNames } from "../core/tool-names.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../tools/registry.js";
import type { HarnessSnapshot } from "./harness/state.js";
import { evaluateSelfDevBashCommand, evaluateSelfDevWritePath, type SelfDevMode } from "./mode.js";

const STALE_WRITES_OVERRIDE_ENV = "CLIO_DEV_ALLOW_STALE_WRITES";

function pathArg(args: Record<string, unknown>): string | null {
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendRestartNotice(result: ToolResult, relativePath: string, reason: string): ToolResult {
	if (result.kind !== "ok") return result;
	const notice = `self-dev: ${relativePath} requires restarting Clio before trusting the running process`;
	const details = isRecord(result.details) ? result.details : {};
	return {
		...result,
		output: result.output.length > 0 ? `${result.output}\n${notice}` : notice,
		details: {
			...details,
			restart: { required: true, reason, path: relativePath },
		},
	};
}

export interface SelfDevToolGuardOptions {
	getHarnessSnapshot?: () => HarnessSnapshot | null;
}

function restartFiles(snapshot: HarnessSnapshot | null | undefined): string[] {
	return snapshot?.kind === "restart-required" ? [...snapshot.files] : [];
}

function staleWriteBlock(relativePath: string, options: SelfDevToolGuardOptions | undefined): ToolResult | null {
	if (!relativePath.startsWith("src/")) return null;
	if (process.env[STALE_WRITES_OVERRIDE_ENV] === "1") return null;
	const paths = restartFiles(options?.getHarnessSnapshot?.());
	if (paths.length === 0) return null;
	const detail = {
		stale_process: {
			restart_required: true,
			restart_required_paths: paths,
			blocked_action: "source_write",
			attempted_path: relativePath,
			override_env: STALE_WRITES_OVERRIDE_ENV,
		},
	};
	return {
		kind: "error",
		message: `stale process guard: restart-required is active; restart Clio before editing source (${paths.join(", ")})`,
		details: detail,
	};
}

function wrapPathMutator(spec: ToolSpec, mode: SelfDevMode, guardOptions?: SelfDevToolGuardOptions): ToolSpec {
	return {
		...spec,
		async run(args, runOptions): Promise<ToolResult> {
			const target = pathArg(args);
			if (!target) return spec.run(args, runOptions);
			const decision = evaluateSelfDevWritePath(mode, target);
			if (!decision.allowed) return { kind: "error", message: decision.reason };
			const staleBlock = staleWriteBlock(decision.relativePath, guardOptions);
			if (staleBlock) return staleBlock;
			const result = await spec.run(args, runOptions);
			return decision.restartRequired
				? appendRestartNotice(result, decision.relativePath, "self-dev source change requires restart")
				: result;
		},
	};
}

function wrapBash(spec: ToolSpec): ToolSpec {
	return {
		...spec,
		async run(args, options): Promise<ToolResult> {
			const command = typeof args.command === "string" ? args.command : "";
			const blocked = evaluateSelfDevBashCommand(command);
			if (blocked) return { kind: "error", message: blocked };
			return spec.run(args, options);
		},
	};
}

export function applySelfDevToolGuards(
	registry: ToolRegistry,
	mode: SelfDevMode,
	options?: SelfDevToolGuardOptions,
): void {
	const write = registry.get(ToolNames.Write);
	if (write) registry.register(wrapPathMutator(write, mode, options));
	const edit = registry.get(ToolNames.Edit);
	if (edit) registry.register(wrapPathMutator(edit, mode, options));
	const bash = registry.get(ToolNames.Bash);
	if (bash) registry.register(wrapBash(bash));
}
