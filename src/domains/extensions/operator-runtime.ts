import { type ExtensionCommandRow, extensionInvocation, resolveExtensionCommands } from "./operator-commands.js";

export {
	type ExtensionCommandRow,
	extensionInvocation,
	isExtensionCommandToken,
	resolveExtensionCommands,
} from "./operator-commands.js";

import { realpathSync } from "node:fs";
import type { ExtensionObservation, ExtensionOutput, ExtensionRuntimeSnapshot, ExtensionStatus } from "./public-api.js";
import { ExtensionRuntimeProcess, type RuntimeProcessState } from "./runtime-process.js";
import { RUNTIME_LIMITS } from "./runtime-schema.js";
import { listInstalledExtensions } from "./state.js";
import {
	type ExtensionProvenance,
	type InstalledExtension,
	isLoadableExtension,
	type LoadableExtension,
} from "./types.js";

export interface OperatorRuntimeEntry {
	id: string;
	scope: "user" | "project";
	generation: number;
	state: RuntimeProcessState | "inactive";
	/** Verified owner of this instance, not a subsequent installed-inventory observation. */
	provenance?: ExtensionProvenance;
	reason?: string;
	status?: ExtensionStatus;
	/** Actual schema admission is still owned by the session/worker registry. */
	newSessionReasons: string[];
	toolEvidence: "frozen-registry" | "runtime-startup-observation";
}
export interface OperatorReloadResult {
	status: "committed" | "deferred" | "rejected";
	generation: number;
	message: string;
}
export interface OperatorRuntimeOptions {
	/** Captured from the existing registry, never inferred from runtime activation. */
	frozenTools?: ReadonlyArray<ExtensionProvenance>;
	onDiagnostic?: (message: string) => void;
	context(): Omit<ExtensionRuntimeSnapshot, "generation">;
	isIdle(): boolean;
	list?: (cwd: string) => InstalledExtension[];
	onChange?: () => void;
	onReload?: (result: OperatorReloadResult) => void;
	/** Synchronous paired snapshot/hook commit. Runtimes have a separate readiness clock. */
	commitHooks?: () => { status: string; generation: number; reason?: string };
	/** Explicit headless invocation starts only its selected owner. */
	onlyId?: string;
}
function identity(entry: InstalledExtension): string {
	return `${entry.id}:${entry.scope}:${entry.provenance?.canonicalRoot}:${entry.provenance?.contentDigest}`;
}
function contextIdentity(context: Omit<ExtensionRuntimeSnapshot, "generation">): string {
	return JSON.stringify(context);
}
/** Owns operator processes only. Never used by native workers or model tool bootstrap. */
export class OperatorExtensionRuntime {
	private processes = new Map<string, ExtensionRuntimeProcess>();
	private inventory: InstalledExtension[] = [];
	private failures = new Map<string, string>();
	private statuses = new Map<string, ExtensionStatus>();
	private initialTools: Map<string, string> | undefined;
	private lastScanMs = 0;
	private observationIssue: string | undefined;
	private generation = 0;
	private lifetime = 0;
	private closed = false;
	private reloading = false;
	private queued = false;
	private activeContext: string | undefined;
	private pendingObservation: ExtensionObservation | undefined;
	private observationTask: Promise<void> | undefined;
	private reloadTask: Promise<OperatorReloadResult> | undefined;
	private retired = new Set<Promise<void>>();
	constructor(private options: OperatorRuntimeOptions) {
		if (options.frozenTools)
			this.initialTools = new Map(
				options.frozenTools.map((provenance) => [
					provenance.id,
					`${provenance.id}:${provenance.scope}:${provenance.canonicalRoot}:${provenance.contentDigest}`,
				]),
			);
	}
	/** No timer or filesystem work is needed without active runtimes or queued reload. */
	get maintenanceDelayMs(): number | null {
		if (this.closed || this.reloading) return null;
		if (this.queued) return 250;
		return [...this.processes.values()].some((process) => process.state === "ready")
			? Math.max(30000, Math.ceil(this.lastScanMs * 100))
			: null;
	}
	maintenance(): void {
		if (this.closed || this.reloading) return;
		if (this.queued) {
			if (!this.busy && this.options.isIdle()) void this.reload("session-change");
			return;
		}
		if (this.maintenanceDelayMs !== null) this.reconcile();
	}
	private reportObservationFailure(error: unknown): void {
		const message = `extension observation unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
			0,
			512,
		);
		if (message === this.observationIssue) return;
		this.observationIssue = message;
		try {
			this.options.onDiagnostic?.(message);
		} catch {
			/* A diagnostic sink has no runtime authority. */
		}
	}
	private context(): Omit<ExtensionRuntimeSnapshot, "generation"> {
		const context = this.options.context();
		return { ...context, workspace: realpathSync(context.workspace) };
	}
	private list(): InstalledExtension[] {
		const start = performance.now();
		try {
			return (this.options.list ?? ((cwd) => listInstalledExtensions(cwd, { all: true })))(this.context().workspace);
		} finally {
			this.lastScanMs = performance.now() - start;
		}
	}
	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* Presentation cannot change runtime authority. */
		}
	}
	private retire(process: ExtensionRuntimeProcess, reason: string): void {
		this.statuses.delete(process.extension.id);
		const task = process.dispose(reason);
		this.retired.add(task);
		void task.finally(() => this.retired.delete(task));
	}
	get busy(): boolean {
		return this.reloading || [...this.processes.values()].some((process) => process.busy);
	}
	/** Synchronous fence for resume/fork/branch switch, including same-session leaf changes. */
	invalidateContext(): void {
		if (this.closed || (!this.processes.size && !this.reloading && !this.queued)) return;
		this.lifetime++;
		for (const process of this.processes.values()) this.retire(process, "session-change");
		this.processes.clear();
		this.queued = true;
		this.changed();
	}
	get activeGeneration(): number {
		return this.generation;
	}
	private eligible(process: ExtensionRuntimeProcess, list: InstalledExtension[]): boolean {
		return list.some((entry) => isLoadableExtension(entry) && identity(entry) === identity(process.extension));
	}
	/** Reverify at command boundaries and on the host's slow lifecycle tick, never during paint. */
	reconcile(): void {
		if (
			this.closed ||
			(!this.queued && !this.reloading && ![...this.processes.values()].some((process) => process.state === "ready"))
		)
			return;
		let context: string;
		let list: InstalledExtension[];
		try {
			context = contextIdentity(this.context());
			list = this.list();
		} catch {
			context = "unavailable";
			list = [];
		}
		this.inventory = list;
		if (this.activeContext !== undefined && context !== this.activeContext) {
			this.lifetime++;
			for (const process of this.processes.values()) this.retire(process, "session-change");
			this.processes.clear();
			this.activeContext = context;
			this.queued = true;
			this.changed();
		}
		for (const [id, process] of this.processes) {
			if (this.eligible(process, list)) continue;
			this.processes.delete(id);
			this.failures.set(id, "installation disabled, removed, replaced, or changed; reload after reviewed installation");
			this.retire(process, "installation-revoked");
			this.changed();
		}
		if (this.queued && !this.busy && this.options.isIdle()) void this.reload("session-change");
	}
	reload(reason: "startup" | "reload" | "session-change" = "reload"): Promise<OperatorReloadResult> {
		if (this.closed)
			return Promise.resolve({ status: "rejected", generation: this.generation, message: "operator runtime is disposed" });
		if (this.busy || !this.options.isIdle()) {
			this.queued = true;
			this.changed();
			return Promise.resolve({
				status: "deferred",
				generation: this.generation,
				message: "extension reload queued until the session and extension commands are idle",
			});
		}
		this.queued = false;
		this.reloading = true;
		this.reloadTask = this.performReload(reason).finally(() => {
			this.reloading = false;
			this.changed();
		});
		return this.reloadTask;
	}
	private async performReload(reason: "startup" | "reload" | "session-change"): Promise<OperatorReloadResult> {
		const staged = new Map<string, ExtensionRuntimeProcess>();
		const failures = new Map<string, string>();
		const lifetime = this.lifetime;
		const next = this.generation + 1;
		let result: OperatorReloadResult;
		try {
			const context = this.context();
			const capturedContext = contextIdentity(context);
			const list = this.list();
			this.inventory = list;
			this.initialTools ??= new Map(
				list
					.filter((entry) => entry.loadable && entry.capabilities?.tools.length)
					.map((entry) => [entry.id, identity(entry)]),
			);
			// Explicit reload restarts every instance. Fence before any async work;
			// failed activation never leaves an ineligible old process callable.
			for (const process of this.processes.values()) this.retire(process, reason);
			this.processes.clear();
			this.statuses.clear();
			await Promise.all(this.retired);
			const eligible = list.filter(
				(entry): entry is LoadableExtension =>
					isLoadableExtension(entry) &&
					entry.runtime !== undefined &&
					(!this.options.onlyId || entry.id === this.options.onlyId),
			);
			for (const entry of eligible.slice(RUNTIME_LIMITS.processes))
				failures.set(entry.id, `operator runtime limit is ${RUNTIME_LIMITS.processes}; disable another runtime and reload`);
			await Promise.all(
				eligible.slice(0, RUNTIME_LIMITS.processes).map(async (entry) => {
					try {
						const process = new ExtensionRuntimeProcess(entry, { ...context, generation: next }, () => {
							if (this.processes.get(entry.id)?.state !== "ready") this.statuses.delete(entry.id);
							this.changed();
						});
						staged.set(entry.id, process);
						await process.staged;
					} catch (error) {
						failures.set(entry.id, error instanceof Error ? error.message : String(error));
					}
				}),
			);
			if (this.closed || lifetime !== this.lifetime || capturedContext !== contextIdentity(this.context()))
				throw new Error("session or workspace changed while staging runtimes");
			const current = this.list();
			if (
				JSON.stringify(list.map(identity)) !== JSON.stringify(current.map(identity)) ||
				list.some((entry, index) => entry.loadable !== current[index]?.loadable)
			)
				throw new Error("extension installations changed while staging; reload again");
			// Preserve the existing synchronous paired hook/snapshot transaction. UI
			// readiness is deliberately reported separately and acknowledged below.
			if (!this.options.isIdle()) {
				this.queued = true;
				throw new Error("session became busy while staging; reload queued until idle");
			}
			const hooks = this.options.commitHooks?.();
			if (hooks && hooks.status !== "committed")
				throw new Error(`hook generation rejected: ${hooks.reason ?? hooks.status}`);
			this.generation = next;
			this.activeContext = capturedContext;
			this.processes = staged;
			this.failures = failures;
			await Promise.all(
				[...staged].map(async ([id, process]) => {
					if (failures.has(id)) return;
					try {
						await process.activate();
					} catch (error) {
						failures.set(id, error instanceof Error ? error.message : String(error));
					}
				}),
			);
			if (this.closed || lifetime !== this.lifetime || capturedContext !== contextIdentity(this.context()))
				throw new Error("session or workspace changed during runtime activation");
			if (context.mode === "interactive") await this.deliverObservation({ event: "session_open", reason });
			const ready = [...staged.values()].filter((process) => process.state === "ready").length;
			const degraded = eligible.length - ready;
			result = {
				status: "committed",
				generation: next,
				message: `operator generation ${next}: ${ready} ready, ${degraded} degraded; tool schemas remain frozen${hooks ? `; hooks/snapshot generation ${hooks.generation}` : ""}`,
			};
		} catch (error) {
			for (const process of new Set([...this.processes.values(), ...staged.values()])) {
				this.retire(process, "reload-rejected");
			}
			this.processes.clear();
			result = {
				status: this.generation === next ? "committed" : "rejected",
				generation: this.generation,
				message: `${this.generation === next ? "operator generation committed but degraded: " : ""}${error instanceof Error ? error.message : String(error)}`,
			};
		}
		this.changed();
		try {
			this.options.onReload?.(result);
		} catch {
			/* Reporting follows settlement. */
		}
		return result;
	}
	commands(promptNames: readonly string[] = []): ExtensionCommandRow[] {
		const rows = this.inventory
			.filter((entry) => entry.effective && entry.runtime)
			.flatMap((entry) =>
				(entry.runtime?.commands ?? []).map((command) => {
					const process = this.processes.get(entry.id);
					const available = process?.state === "ready" && entry.loadable && !this.reloading;
					const reason = available
						? undefined
						: (this.failures.get(entry.id) ??
							process?.failure ??
							(!entry.loadable
								? "installation is not enabled and eligible"
								: this.reloading
									? "runtime reload in progress"
									: "runtime not ready; reload extensions"));
					return {
						origin: "extension" as const,
						invocation: extensionInvocation(entry.id, command.name),
						extensionId: entry.id,
						scope: entry.scope,
						description: command.description,
						generation: this.generation,
						available,
						...(reason ? { reason } : {}),
					};
				}),
			);
		return resolveExtensionCommands(rows, promptNames);
	}
	entries(): OperatorRuntimeEntry[] {
		return this.inventory.map((entry) => {
			const process = this.processes.get(entry.id);
			const current = process && identity(process.extension) === identity(entry) ? process : undefined;
			const reason = this.failures.get(entry.id) ?? current?.failure;
			const status = current?.state === "ready" ? this.statuses.get(entry.id) : undefined;
			const initial = this.initialTools?.get(entry.id);
			const newSessionReasons =
				(entry.capabilities?.tools.length || initial) && initial !== identity(entry)
					? [
							this.options.frozenTools
								? "installed package differs from the frozen tool registry (or was not admitted there); a new session is required for tool admission"
								: "package differs from the runtime-startup observation; actual frozen tool binding is unknown here, inspect the registry or start a new session",
						]
					: [];
			return {
				id: entry.id,
				scope: entry.scope,
				generation: this.generation,
				state: current?.state ?? "inactive",
				...(current ? { provenance: current.extension.provenance } : {}),
				...(reason ? { reason } : {}),
				...(status ? { status } : {}),
				newSessionReasons,
				toolEvidence: this.options.frozenTools ? "frozen-registry" : "runtime-startup-observation",
			};
		});
	}
	async invoke(
		invocation: string,
		args: string,
		promptNames: readonly string[] = [],
		signal?: AbortSignal,
	): Promise<ExtensionOutput> {
		this.reconcile();
		if (this.closed || !this.options.isIdle() || this.reloading)
			throw new Error("extension command requires an idle session");
		if (Buffer.byteLength(args) > RUNTIME_LIMITS.argumentBytes) throw new Error("extension arguments exceed 16 KiB");
		const row = this.commands(promptNames).find((row) => row.invocation === invocation);
		if (!row?.available) throw new Error(row?.reason ?? `/${invocation} is not an available extension command`);
		const process = this.processes.get(row.extensionId);
		const name = invocation.slice(invocation.lastIndexOf(":") + 1);
		const command = process?.declaration.commands.find((command) => command.name === name);
		if (!process || !command) throw new Error("extension command unavailable");
		const context = contextIdentity(this.context());
		const output = await process.request({ kind: "command", name, args }, command.timeoutMs, signal);
		this.reconcile();
		if (
			this.closed ||
			signal?.aborted ||
			context !== contextIdentity(this.context()) ||
			this.processes.get(row.extensionId) !== process ||
			process.state !== "ready"
		)
			throw new Error("extension result belongs to a revoked runtime or session");
		this.applyOutput(process, output);
		return output;
	}
	private applyOutput(process: ExtensionRuntimeProcess, output: ExtensionOutput): void {
		if (this.processes.get(process.extension.id) !== process || process.state !== "ready") return;
		if (output.status === null) this.statuses.delete(process.extension.id);
		else if (output.status) this.statuses.set(process.extension.id, output.status);
		this.changed();
	}
	observe(observation: ExtensionObservation): void {
		if (
			this.closed ||
			![...this.processes.values()].some(
				(process) => process.state === "ready" && process.declaration.events.includes(observation.event),
			)
		)
			return;
		this.pendingObservation = observation; // One coalesced, body-free observation; no event history.
		if (this.observationTask) return;
		this.observationTask = (async () => {
			while (this.pendingObservation && !this.closed) {
				const next = this.pendingObservation;
				this.pendingObservation = undefined;
				await this.deliverObservation(next);
			}
		})()
			.catch((error) => this.reportObservationFailure(error))
			.finally(() => {
				this.observationTask = undefined;
			});
	}
	private async deliverObservation(observation: ExtensionObservation): Promise<void> {
		try {
			const context = contextIdentity(this.context());
			const candidates = [...this.processes.values()].filter(
				(process) => process.state === "ready" && !process.busy && process.declaration.events.includes(observation.event),
			);
			if (candidates.length === 0) return;
			const admitted = this.list();
			const responses = await Promise.all(
				candidates.map(async (process) => {
					const { generation: _generation, ...processContext } = process.snapshot;
					if (contextIdentity(processContext) !== context || !this.eligible(process, admitted)) return null;
					try {
						return { process, output: await process.request({ kind: "observe", observation }, RUNTIME_LIMITS.observationMs) };
					} catch (error) {
						this.reportObservationFailure(error);
						if (this.processes.get(process.extension.id) === process) this.statuses.delete(process.extension.id);
						this.changed();
						return null;
					}
				}),
			);
			if (this.closed) return;
			if (context !== contextIdentity(this.context())) {
				this.reconcile();
				return;
			}
			const current = this.list();
			for (const response of responses) {
				if (!response) continue;
				if (this.eligible(response.process, current)) this.applyOutput(response.process, response.output);
				else this.reconcile();
			}
		} catch (error) {
			this.reportObservationFailure(error);
			this.reconcile();
		}
	}
	cancel(): void {
		for (const process of this.processes.values()) if (process.busy) this.retire(process, "operator-cancelled");
	}
	async dispose(): Promise<void> {
		this.closed = true;
		this.lifetime++;
		this.pendingObservation = undefined;
		for (const process of this.processes.values()) this.retire(process, "session-closed");
		this.processes.clear();
		await this.reloadTask;
		await this.observationTask;
		await Promise.all(this.retired);
	}
}
