import type { ExtensionCommandRow } from "./operator-commands.js";
import {
	OperatorExtensionRuntime,
	type OperatorReloadResult,
	type OperatorRuntimeEntry,
	type OperatorRuntimeOptions,
} from "./operator-runtime.js";
import { OperatorExtensionRuntimeV2 } from "./operator-runtime-v2.js";
import type { ExtensionObservation, ExtensionOutput } from "./public-api.js";
import type {
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionSkin,
	ExtensionUiAction,
	InterviewAnswer,
	InterviewNext,
} from "./public-api-v2.js";
import type { ExtensionSurfaceModel } from "./surface-model.js";

/** A command's output, tagged with the API that produced it so a surface knows which shape it holds. */
export type OperatorCommandOutput = (ExtensionOutput & { api: 1 }) | (ExtensionOutputV2 & { api: 2 });

export interface OperatorExtensionsOptions extends OperatorRuntimeOptions {
	stateDir?: () => string;
	surface?: ExtensionSurfaceModel;
}

type ReloadReason = "startup" | "reload" | "session-change";

function rank(result: OperatorReloadResult): number {
	if (result.status === "rejected") return 3;
	if (result.status === "deferred") return 2;
	return result.degraded === undefined || result.degraded > 0 ? 1 : 0;
}

/**
 * One operator-extension surface over the api 1 and api 2 managers. Each
 * manager keeps its own fencing; this only fans calls out, routes a command to
 * the manager that owns it, and reports one reload instead of two.
 */
export class OperatorExtensions {
	readonly v1: OperatorExtensionRuntime;
	readonly v2: OperatorExtensionRuntimeV2;
	/** While above zero, a manager's own reload report is folded into the combined one. */
	private combining = 0;

	constructor(private readonly options: OperatorExtensionsOptions) {
		const forward = (result: OperatorReloadResult, reason: ReloadReason): void => {
			if (this.combining === 0) options.onReload?.(result, reason);
		};
		const { stateDir, surface, onReload: _onReload, frozenTools, commitHooks, ...shared } = options;
		this.v1 = new OperatorExtensionRuntime({
			...shared,
			...(frozenTools ? { frozenTools } : {}),
			...(commitHooks ? { commitHooks } : {}),
			onReload: forward,
		});
		this.v2 = new OperatorExtensionRuntimeV2({
			...shared,
			...(stateDir ? { stateDir } : {}),
			...(surface ? { surface } : {}),
			reserved: () =>
				this.v1
					.entries()
					.filter((entry) => entry.state === "staging" || entry.state === "starting" || entry.state === "ready").length,
			onReload: forward,
		});
	}

	get surface(): ExtensionSurfaceModel {
		return this.v2.surface;
	}
	get busy(): boolean {
		return this.v1.busy || this.v2.busy;
	}
	get maintenanceDelayMs(): number | null {
		const delays = [this.v1.maintenanceDelayMs, this.v2.maintenanceDelayMs].filter((delay) => delay !== null);
		return delays.length > 0 ? Math.min(...delays) : null;
	}
	maintenance(): void {
		this.v1.maintenance();
		this.v2.maintenance();
	}
	invalidateContext(): void {
		this.v1.invalidateContext();
		this.v2.invalidateContext();
	}

	/** api 1 first: it commits the paired hook generation, and its runtimes claim the shared cap first. */
	async reload(reason: ReloadReason = "reload"): Promise<OperatorReloadResult> {
		this.combining++;
		let results: [OperatorReloadResult, OperatorReloadResult];
		try {
			const first = await this.v1.reload(reason);
			results = [first, await this.v2.reload(reason)];
		} finally {
			this.combining--;
		}
		const result = this.combine(results);
		try {
			this.options.onReload?.(result, reason);
		} catch {
			/* Reporting follows settlement. */
		}
		return result;
	}
	private combine([first, second]: [OperatorReloadResult, OperatorReloadResult]): OperatorReloadResult {
		const worst = rank(first) >= rank(second) ? first : second;
		if (rank(worst) >= 2) return worst;
		if (rank(worst) === 1 && worst.degraded === undefined) return worst;
		const degraded = (first.degraded ?? 0) + (second.degraded ?? 0);
		const entries = this.entries();
		const ready = entries.filter((entry) => entry.state === "ready").length;
		const waiting = this.v2.onDemandCount;
		const later = waiting > 0 ? `; ${waiting} start on first use` : "";
		return {
			status: "committed",
			generation: first.generation,
			degraded,
			message:
				degraded > 0
					? `Extensions: ${degraded} failed to start; ${ready} ready${later}. Open /extensions to inspect.`
					: ready + waiting > 0
						? `Extensions reloaded: ${ready} ready${later}.`
						: "Extensions reloaded. No runtime extensions enabled.",
		};
	}

	commands(promptNames: readonly string[] = []): ExtensionCommandRow[] {
		return [...this.v1.commands(promptNames), ...this.v2.commands(promptNames)];
	}
	/** One row per installed package; an api 2 package is reported by the api 2 manager only. */
	entries(): OperatorRuntimeEntry[] {
		const second = this.v2.entries();
		const owned = new Set(second.map((entry) => `${entry.id}:${entry.scope}`));
		return [...this.v1.entries().filter((entry) => !owned.has(`${entry.id}:${entry.scope}`)), ...second];
	}
	async invoke(
		invocation: string,
		args: string,
		promptNames: readonly string[] = [],
		signal?: AbortSignal,
	): Promise<OperatorCommandOutput> {
		if (this.v2.commands(promptNames).some((row) => row.invocation === invocation))
			return { api: 2, ...(await this.v2.invoke(invocation, args, promptNames, signal)) };
		return { api: 1, ...(await this.v1.invoke(invocation, args, promptNames, signal)) };
	}
	/** api 1 observations carry no data; api 2 observations arrive through `observeV2` with theirs. */
	observe(observation: ExtensionObservation): void {
		this.v1.observe(observation);
	}
	observeV2(observation: ExtensionObservationV2): void {
		this.v2.observe(observation);
	}
	action(extensionId: string, event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		return this.v2.action(extensionId, event);
	}
	interview(extensionId: string, answer: InterviewAnswer): Promise<InterviewNext> {
		return this.v2.interview(extensionId, answer);
	}
	leaveWorkspace(): boolean {
		return this.v2.leaveWorkspace();
	}
	closePanel(extensionId: string): void {
		this.v2.closePanel(extensionId);
	}
	skinFor(extensionId: string, workspaceId: string): ExtensionSkin | null {
		return this.v2.skinFor(extensionId, workspaceId);
	}
	cancel(): void {
		this.v1.cancel();
		this.v2.cancel();
	}
	async dispose(): Promise<void> {
		await Promise.all([this.v1.dispose(), this.v2.dispose()]);
	}
}
