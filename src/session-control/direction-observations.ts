import { join } from "node:path";
import { ToolNames } from "../core/tool-names.js";
import type { DirectionBlockInput } from "../domains/turn-control/render.js";
import type { ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";

export type DirectionObservation = DirectionBlockInput;

function codemapAreas(text: string): string | null {
	const data: unknown = JSON.parse(text);
	if (data === null || typeof data !== "object" || !("files" in data) || !Array.isArray(data.files)) return null;
	const areas = new Map<string, number>();
	for (const file of data.files) {
		if (file === null || typeof file !== "object" || typeof file.path !== "string") continue;
		const parts = file.path.split("/").filter(Boolean);
		const area = parts.length > 1 ? (parts[0] as string) : ".";
		areas.set(area, (areas.get(area) ?? 0) + 1);
	}
	return (
		[...areas]
			.sort(([a], [b]) => a.localeCompare(b))
			.slice(0, 12)
			.map(([area, count]) => `${area}: ${count} files`)
			.join("; ") || null
	);
}

/** S7: host observations use ordinary admission and a shared deadline, never an unchecked shell path. */
export async function observeWorkspace(input: {
	registry: Pick<ToolRegistry, "invoke">;
	cwd: string;
	invokeOptions: ToolInvokeOptions;
	observations: ReadonlyArray<"git-status" | "git-log" | "tree" | "codemap">;
}): Promise<DirectionObservation> {
	const signal = input.invokeOptions.signal
		? AbortSignal.any([input.invokeOptions.signal, AbortSignal.timeout(5000)])
		: AbortSignal.timeout(5000);
	const options = { ...input.invokeOptions, origin: "harness" as const, signal };
	const invoke = async (
		tool: Parameters<ToolRegistry["invoke"]>[0]["tool"],
		args: Record<string, unknown>,
	): Promise<string | null> => {
		if (signal.aborted) return null;
		let stop!: () => void;
		const canceled = new Promise<null>((resolve) => {
			stop = () => resolve(null);
		});
		signal.addEventListener("abort", stop, { once: true });
		try {
			return await Promise.race([
				input.registry
					.invoke({ tool, args }, options)
					.then((verdict) => (verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : null)),
				canceled,
			]);
		} catch {
			// S7: an unavailable observation leaves only its field unknown.
			return null;
		} finally {
			signal.removeEventListener("abort", stop);
		}
	};
	const requested = new Set(input.observations);
	const gitArgs = { cwd: input.cwd, timeout_ms: 5000, max_output_bytes: 16000 };
	const [status, log, tree, codemap] = await Promise.all([
		requested.has("git-status") ? invoke(ToolNames.Git, { ...gitArgs, op: "status" }) : null,
		requested.has("git-log") ? invoke(ToolNames.Git, { ...gitArgs, op: "log", limit: 3 }) : null,
		requested.has("tree") ? invoke(ToolNames.Ls, { path: input.cwd, limit: 40 }) : null,
		requested.has("codemap") ? invoke(ToolNames.Read, { path: join(input.cwd, ".clio-coder", "codemap.json") }) : null,
	]);
	const changes = status?.split(/\r?\n/u).filter((row) => row.length > 0 && !row.startsWith("##")) ?? [];
	let areas: string | null = null;
	if (codemap !== null) {
		try {
			areas = codemapAreas(codemap);
		} catch {
			// S7: a truncated or malformed codemap cannot supply trustworthy counts.
		}
	}
	return {
		cwd: input.cwd,
		git:
			status === null || log === null || !status.startsWith("## ")
				? null
				: {
						branch: status.split(/\r?\n/u)[0]?.slice(3).split("...")[0] ?? "unknown",
						modified: changes.filter((row) => !row.startsWith("??")).length,
						untracked: changes.filter((row) => row.startsWith("??")).length,
						recent: log
							.split(/\r?\n/u)
							.filter(Boolean)
							.slice(0, 3)
							.map((row) => row.replace(/^\S+\s+/u, "")),
					},
		tree:
			tree === null
				? null
				: tree
						.split(/\r?\n/u)
						.filter((row) => row.length > 0 && !row.startsWith("["))
						.sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
						.slice(0, 40),
		codemap: areas,
	};
}
