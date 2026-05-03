import { ToolNames } from "../core/tool-names.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../tools/registry.js";
import { evaluateSelfDevBashCommand, evaluateSelfDevWritePath, type SelfDevMode } from "./mode.js";

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

function wrapPathMutator(spec: ToolSpec, mode: SelfDevMode): ToolSpec {
	return {
		...spec,
		async run(args, options): Promise<ToolResult> {
			const target = pathArg(args);
			if (!target) return spec.run(args, options);
			const decision = evaluateSelfDevWritePath(mode, target);
			if (!decision.allowed) return { kind: "error", message: decision.reason };
			const result = await spec.run(args, options);
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

export function applySelfDevToolGuards(registry: ToolRegistry, mode: SelfDevMode): void {
	const write = registry.get(ToolNames.Write);
	if (write) registry.register(wrapPathMutator(write, mode));
	const edit = registry.get(ToolNames.Edit);
	if (edit) registry.register(wrapPathMutator(edit, mode));
	const bash = registry.get(ToolNames.Bash);
	if (bash) registry.register(wrapBash(bash));
}
