import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { type ExtensionCommandRow, extensionInvocation, resolveExtensionCommands } from "./operator-commands.js";
import type { OperatorReloadResult, OperatorRuntimeEntry } from "./operator-runtime.js";
import type { ExtensionRuntimeSnapshot } from "./public-api.js";
import type {
	ExtensionEffect,
	ExtensionHookEvent,
	ExtensionObservationEventV2,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionSkin,
	ExtensionUiAction,
	InterviewAnswer,
	InterviewNext,
} from "./public-api-v2.js";
import type { OutputOrigin } from "./runtime-output-v2.js";
import {
	type ExtensionKeyValueHost,
	ExtensionRequestTimeout,
	ExtensionRuntimeProcessV2,
} from "./runtime-process-v2.js";
import { RUNTIME_LIMITS } from "./runtime-schema.js";
import { RUNTIME_V2_LIMITS } from "./runtime-schema-v2.js";
import { createExtensionKeyValueHost, extensionDataPaths } from "./runtime-state.js";
import { type ExtensionGlobWatch, watchExtensionGlobs } from "./runtime-watch.js";
import { validateSkin } from "./skin-schema.js";
import { listInstalledExtensions } from "./state.js";
import { type ActiveExtensionWorkspace, ExtensionSurfaceModel } from "./surface-model.js";
import { type InstalledExtension, isLoadableExtension, type LoadableExtension } from "./types.js";

type RuntimeContext = Omit<ExtensionRuntimeSnapshot, "generation">;

/** How one awaited hook ended. The registration that asked decides what a miss or a failure costs. */
export type ExtensionHookOutcome =
	| { kind: "ok"; effects: ExtensionEffect[] }
	| { kind: "timeout" }
	| { kind: "error"; message: string };
type ReloadReason = "startup" | "reload" | "session-change";

export interface OperatorRuntimeV2Options {
	context(): RuntimeContext;
	isIdle(): boolean;
	list?: (cwd: string) => InstalledExtension[];
	/** Root of per-extension state, store and files. */
	stateDir?: () => string;
	surface?: ExtensionSurfaceModel;
	/** Processes another manager already holds against the shared cap. */
	reserved?: () => number;
	onChange?: () => void;
	onDiagnostic?: (message: string) => void;
	onReload?: (result: OperatorReloadResult, reason: ReloadReason) => void;
	/** Explicit headless invocation starts only its selected owner. */
	onlyId?: string;
}

/** Observations a slow runtime may fall behind by before the oldest is dropped. */
const OBSERVATION_BACKLOG = 64;

function identity(entry: InstalledExtension): string {
	return `${entry.id}:${entry.scope}:${entry.provenance?.canonicalRoot}:${entry.provenance?.contentDigest}`;
}
function contextKey(context: RuntimeContext): string {
	return JSON.stringify(context);
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
type ApiV2Extension = LoadableExtension & { runtimeV2: NonNullable<LoadableExtension["runtimeV2"]> };
function isApiV2(entry: InstalledExtension): entry is ApiV2Extension {
	return isLoadableExtension(entry) && entry.runtimeV2 !== undefined;
}
/** A package that only answers commands has nothing to do until the operator asks. */
function startsOnDemand(entry: ApiV2Extension): boolean {
	const declared = entry.runtimeV2;
	return (
		declared.events.length === 0 &&
		declared.tickMs === undefined &&
		declared.hooks.length === 0 &&
		declared.tools.length === 0 &&
		declared.watch.length === 0 &&
		declared.workspaces.length === 0
	);
}
function subscribes(process: ExtensionRuntimeProcessV2, event: ExtensionObservationEventV2): boolean {
	return event === "tick"
		? process.declaration.tickMs !== undefined
		: (process.declaration.events as readonly string[]).includes(event);
}

/**
 * The observation as one extension may see it: content fields cross only for
 * the access classes its manifest declares. Metadata always crosses.
 */
function visibleTo(event: ExtensionObservationV2, access: ReadonlyArray<string>): ExtensionObservationV2 {
	if (event.event === "turn_start" && event.text !== undefined && !access.includes("prompt")) {
		const { text: _text, ...rest } = event;
		return rest;
	}
	if (event.event === "turn_end" && event.text !== undefined && !access.includes("assistant-text")) {
		const { text: _text, ...rest } = event;
		return rest;
	}
	if (event.event === "tool_end") {
		const { args, result, ...rest } = event;
		return {
			...rest,
			...(args !== undefined && access.includes("tool-args") ? { args } : {}),
			...(result !== undefined && access.includes("tool-results") ? { result } : {}),
		};
	}
	return event;
}

interface ObservationQueue {
	events: ExtensionObservationV2[];
	draining: boolean;
}

/**
 * Owns api 2 runtimes for the operator surfaces. A sibling of the api 1
 * manager rather than a mode of it: state, store and the picture live in the
 * host, so a reload restarts every process and loses nothing but in-flight
 * requests. A result is applied only while the process that produced it is
 * still the current one for the same session and installation. Never used by
 * native workers or model tool bootstrap.
 */
export class OperatorExtensionRuntimeV2 {
	readonly surface: ExtensionSurfaceModel;
	private processes = new Map<string, ExtensionRuntimeProcessV2>();
	/** Eligible this generation and not yet started. */
	private deferred = new Map<string, ApiV2Extension>();
	private starting = new Map<string, Promise<ExtensionRuntimeProcessV2>>();
	private inventory: InstalledExtension[] = [];
	private failures = new Map<string, string>();
	private queues = new Map<ExtensionRuntimeProcessV2, ObservationQueue>();
	/** Host-driven schedules; a runtime never keeps its own timers or watches. */
	private ticks = new Map<ExtensionRuntimeProcessV2, ReturnType<typeof setInterval>>();
	private watches = new Map<ExtensionRuntimeProcessV2, ExtensionGlobWatch>();
	/** The last state host per extension, so state kept before a session existed follows into the first one. */
	private stateHosts = new Map<string, { sessionId: string | null; host: ExtensionKeyValueHost }>();
	private operatorRequests = new Set<AbortController>();
	private retired = new Set<Promise<void>>();
	private generation = 0;
	private lifetime = 0;
	private activeContext: string | undefined;
	/** Session the committed generation belongs to; a workspace survives a reload only within it. */
	private sessionId: string | null | undefined;
	private closed = false;
	private reloading = false;
	private queued = false;
	private reloadTask: Promise<OperatorReloadResult> | undefined;
	private lastScanMs = 0;
	private lastIssue: string | undefined;

	constructor(private readonly options: OperatorRuntimeV2Options) {
		this.surface = options.surface ?? new ExtensionSurfaceModel();
	}

	get activeGeneration(): number {
		return this.generation;
	}
	/** Operator requests and reloads only. Background observations never make the session look busy. */
	get busy(): boolean {
		return this.reloading || this.operatorRequests.size > 0 || this.starting.size > 0;
	}
	/** Eligible packages that start on their first command. */
	get onDemandCount(): number {
		return this.deferred.size;
	}
	/** Live processes, for the cap shared with the api 1 manager. */
	get processCount(): number {
		const live = [...this.processes.values()].filter(
			(process) => process.state !== "failed" && process.state !== "disposed",
		);
		return live.length + this.starting.size;
	}
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

	private report(text: string): void {
		const line = text.slice(0, 512);
		if (line === this.lastIssue) return;
		this.lastIssue = line;
		try {
			this.options.onDiagnostic?.(line);
		} catch {
			/* A diagnostic sink has no runtime authority. */
		}
	}
	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* Presentation cannot change runtime authority. */
		}
	}
	private context(): RuntimeContext {
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
	private capacity(): number {
		return RUNTIME_V2_LIMITS.processes - (this.options.reserved?.() ?? 0) - this.processCount;
	}
	private limitReason(): string {
		return `operator runtime limit is ${RUNTIME_V2_LIMITS.processes} across api 1 and api 2; disable another runtime and reload`;
	}
	private retire(process: ExtensionRuntimeProcessV2, reason: string): void {
		this.disarm(process);
		this.queues.delete(process);
		const task = process.dispose(reason);
		this.retired.add(task);
		void task.finally(() => this.retired.delete(task));
	}
	private retireAll(reason: string): void {
		for (const process of this.processes.values()) this.retire(process, reason);
		this.processes.clear();
		this.deferred.clear();
	}
	private workspaceFor(extensionId: string): string | null {
		const active = this.surface.activeWorkspace;
		return active?.extensionId === extensionId ? active.workspaceId : null;
	}
	private spawn(entry: ApiV2Extension, context: RuntimeContext, generation: number): ExtensionRuntimeProcessV2 {
		const paths = extensionDataPaths((this.options.stateDir ?? clioStateDir)(), entry.id, context.sessionId);
		const keyValue = createExtensionKeyValueHost(paths);
		// The TUI has no session id until its first turn. What an extension kept
		// in memory before then belongs to the session that turn creates.
		const previous = this.stateHosts.get(entry.id);
		if (previous?.sessionId === null && context.sessionId !== null)
			for (const key of previous.host.keys("state"))
				if (keyValue.get("state", key).version === 0) keyValue.set("state", key, previous.host.get("state", key).value);
		this.stateHosts.set(entry.id, { sessionId: context.sessionId, host: keyValue });
		const created: { process?: ExtensionRuntimeProcessV2 } = {};
		created.process = new ExtensionRuntimeProcessV2(entry, {
			snapshot: { ...context, generation, activeWorkspace: this.workspaceFor(entry.id) },
			options: Object.fromEntries(entry.runtimeV2.config.map((field) => [field.key, field.default])),
			keyValue,
			storeDir: paths.storeDir,
			onState: () => {
				if (created.process && this.processes.get(entry.id) === created.process) this.changed();
			},
		});
		return created.process;
	}
	private current(process: ExtensionRuntimeProcessV2): boolean {
		return !this.closed && this.processes.get(process.extension.id) === process && process.state === "ready";
	}

	/** Synchronous fence for resume, fork and branch switch, including same-session leaf changes. */
	invalidateContext(): void {
		if (this.closed || (!this.processes.size && !this.deferred.size && !this.reloading && !this.queued)) return;
		this.lifetime++;
		this.retireAll("session-change");
		// The reload that follows decides whether the workspace survives; a leaf switch keeps it.
		this.surface.reset(() => true);
		this.queued = true;
		this.changed();
	}

	/** Reverify at command boundaries and on the slow lifecycle tick, never during paint. */
	reconcile(): void {
		if (this.closed || (!this.queued && !this.reloading && this.processes.size === 0 && this.deferred.size === 0)) return;
		let context: string;
		let list: InstalledExtension[];
		try {
			context = contextKey(this.context());
			list = this.list();
		} catch {
			context = "unavailable";
			list = [];
		}
		this.inventory = list;
		if (this.activeContext !== undefined && context !== this.activeContext) {
			this.invalidateContext();
			this.activeContext = context;
		}
		const admitted = new Set(list.filter(isApiV2).map(identity));
		for (const [id, process] of this.processes) {
			if (admitted.has(identity(process.extension))) continue;
			this.processes.delete(id);
			this.failures.set(id, "installation disabled, removed, replaced, or changed; reload after reviewed installation");
			this.retire(process, "installation-revoked");
			if (this.surface.activeWorkspace?.extensionId === id) this.surface.leaveWorkspace();
			this.changed();
		}
		for (const [id, entry] of this.deferred) if (!admitted.has(identity(entry))) this.deferred.delete(id);
		if (this.queued && !this.busy && this.options.isIdle()) void this.reload("session-change");
	}

	reload(reason: ReloadReason = "reload"): Promise<OperatorReloadResult> {
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

	private async performReload(reason: ReloadReason): Promise<OperatorReloadResult> {
		const staged = new Map<string, ExtensionRuntimeProcessV2>();
		const deferred = new Map<string, ApiV2Extension>();
		const failures = new Map<string, string>();
		const lifetime = this.lifetime;
		const next = this.generation + 1;
		let result: OperatorReloadResult;
		try {
			const context = this.context();
			const key = contextKey(context);
			const list = this.list();
			this.inventory = list;
			// Every instance restarts; state and the picture are host-held, so nothing is lost but in-flight work.
			this.retireAll(reason);
			await Promise.all(this.retired);
			const eligible = list.filter(
				(entry): entry is ApiV2Extension => isApiV2(entry) && (!this.options.onlyId || entry.id === this.options.onlyId),
			);
			let room = this.capacity();
			for (const entry of eligible) {
				if (!this.options.onlyId && startsOnDemand(entry)) {
					deferred.set(entry.id, entry);
					continue;
				}
				if (room <= 0) {
					failures.set(entry.id, this.limitReason());
					continue;
				}
				room--;
				try {
					staged.set(entry.id, this.spawn(entry, context, next));
				} catch (error) {
					failures.set(entry.id, message(error));
				}
			}
			await Promise.all(
				[...staged].map(async ([id, process]) => {
					try {
						await process.staged;
					} catch (error) {
						failures.set(id, message(error));
					}
				}),
			);
			if (this.closed || lifetime !== this.lifetime || key !== contextKey(this.context()))
				throw new Error("session or workspace changed while staging runtimes");
			const current = this.list();
			if (
				JSON.stringify(list.map(identity)) !== JSON.stringify(current.map(identity)) ||
				list.some((entry, index) => entry.loadable !== current[index]?.loadable)
			)
				throw new Error("extension installations changed while staging; reload again");
			if (!this.options.isIdle()) {
				this.queued = true;
				throw new Error("session became busy while staging; reload queued until idle");
			}
			const sameSession = this.sessionId === context.sessionId;
			this.generation = next;
			this.sessionId = context.sessionId;
			this.activeContext = key;
			this.processes = staged;
			this.deferred = deferred;
			this.failures = failures;
			// The picture is rebuilt by the new generation; a workspace stays only while its owner can still hold it.
			this.surface.reset(
				(active) =>
					sameSession &&
					eligible.some(
						(entry) =>
							entry.id === active.extensionId &&
							entry.runtimeV2.workspaces.some((workspace) => workspace.id === active.workspaceId),
					),
			);
			await Promise.all(
				[...staged].map(async ([id, process]) => {
					if (failures.has(id)) return;
					try {
						await process.activate();
					} catch (error) {
						failures.set(id, message(error));
					}
				}),
			);
			if (this.closed || lifetime !== this.lifetime || key !== contextKey(this.context()))
				throw new Error("session or workspace changed during runtime activation");
			if (context.mode === "interactive") {
				for (const process of staged.values()) if (this.current(process)) this.arm(process, context.workspace);
				this.observe({ event: "session_open", reason });
				const active = this.surface.activeWorkspace;
				if (active) this.observeOne(active.extensionId, { event: "workspace_enter", workspace: active.workspaceId });
			}
			const ready = [...staged.values()].filter((process) => process.state === "ready").length;
			const degraded = eligible.length - deferred.size - ready;
			const waiting = deferred.size > 0 ? `; ${deferred.size} start on first use` : "";
			result = {
				status: "committed",
				generation: next,
				degraded,
				message:
					degraded > 0
						? `Extensions: ${degraded} failed to start; ${ready} ready${waiting}. Open /extensions to inspect.`
						: ready + deferred.size > 0
							? `Extensions reloaded: ${ready} ready${waiting}.`
							: "Extensions reloaded. No runtime extensions enabled.",
			};
		} catch (error) {
			for (const process of new Set([...this.processes.values(), ...staged.values()]))
				this.retire(process, "reload-rejected");
			this.processes.clear();
			this.deferred.clear();
			result = {
				status: this.generation === next ? "committed" : "rejected",
				generation: this.generation,
				message: `${this.generation === next ? "Extensions reloaded with errors: " : "Extension reload failed: "}${message(error)}`,
			};
		}
		this.changed();
		try {
			this.options.onReload?.(result, reason);
		} catch {
			/* Reporting follows settlement. */
		}
		return result;
	}

	/** Start a deferred package on its first use, once, counted against the shared cap. */
	private ensure(entry: ApiV2Extension): Promise<ExtensionRuntimeProcessV2> {
		const running = this.processes.get(entry.id);
		if (running) return Promise.resolve(running);
		const pending = this.starting.get(entry.id);
		if (pending) return pending;
		if (!this.deferred.has(entry.id)) return Promise.reject(new Error("extension runtime is not available"));
		if (this.capacity() <= 0) return Promise.reject(new Error(this.limitReason()));
		const generation = this.generation;
		const lifetime = this.lifetime;
		const task = (async () => {
			const process = this.spawn(entry, this.context(), generation);
			try {
				await process.staged;
				await process.activate();
			} catch (error) {
				this.retire(process, "start-failed");
				if (generation === this.generation) this.failures.set(entry.id, message(error));
				throw error;
			}
			if (this.closed || lifetime !== this.lifetime || generation !== this.generation || !this.deferred.has(entry.id)) {
				this.retire(process, "superseded");
				throw new Error("extensions reloaded while this runtime started");
			}
			this.deferred.delete(entry.id);
			this.processes.set(entry.id, process);
			return process;
		})().finally(() => {
			this.starting.delete(entry.id);
			this.changed();
		});
		this.starting.set(entry.id, task);
		this.changed();
		return task;
	}

	commands(promptNames: readonly string[] = []): ExtensionCommandRow[] {
		const rows = this.inventory
			.filter((entry) => entry.effective && entry.runtimeV2)
			.flatMap((entry) =>
				(entry.runtimeV2?.commands ?? []).flatMap((command) => {
					const process = this.processes.get(entry.id);
					const failure = this.failures.get(entry.id) ?? process?.failure;
					const available =
						entry.loadable &&
						!this.reloading &&
						failure === undefined &&
						(process ? process.state === "ready" : this.deferred.has(entry.id));
					const reason = available
						? undefined
						: (failure ??
							(!entry.loadable
								? "installation is not enabled and eligible"
								: this.reloading
									? "runtime reload in progress"
									: "runtime not ready; reload extensions"));
					const row: ExtensionCommandRow = {
						origin: "extension" as const,
						invocation: extensionInvocation(entry.id, command.name),
						extensionId: entry.id,
						scope: entry.scope,
						description: command.description,
						generation: this.generation,
						available,
						...(reason ? { reason } : {}),
					};
					return entry.bundle && command.replaces === "prompt"
						? [row, { ...row, invocation: `${entry.bundle.pluginId}:${command.name}`, replaces: "prompt" as const }]
						: [row];
				}),
			);
		return resolveExtensionCommands(rows, promptNames);
	}

	entries(): OperatorRuntimeEntry[] {
		return this.inventory
			.filter((entry) => entry.runtimeV2)
			.map((entry) => {
				const process = this.processes.get(entry.id);
				const current = process && identity(process.extension) === identity(entry) ? process : undefined;
				const reason =
					this.failures.get(entry.id) ??
					current?.failure ??
					(!current && this.deferred.has(entry.id) ? "starts on first command" : undefined);
				const status = current?.state === "ready" ? this.surface.entry(entry.id)?.status : undefined;
				return {
					id: entry.id,
					scope: entry.scope,
					generation: this.generation,
					state: current?.state ?? "inactive",
					...(current ? { provenance: current.extension.provenance } : {}),
					...(reason ? { reason } : {}),
					...(status ? { status } : {}),
					newSessionReasons: [],
					toolEvidence: "runtime-startup-observation" as const,
				};
			});
	}

	/**
	 * Run something the operator did against one runtime, and apply what it
	 * returns only while that runtime is still current for the same session.
	 */
	private async operator<T>(
		entry: ApiV2Extension,
		run: (process: ExtensionRuntimeProcessV2, signal: AbortSignal) => Promise<T>,
		apply: (process: ExtensionRuntimeProcessV2, value: T) => void,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		if (signal?.aborted) controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		this.operatorRequests.add(controller);
		this.changed();
		try {
			const process = await this.ensure(entry);
			const key = contextKey(this.context());
			const lifetime = this.lifetime;
			const value = await run(process, controller.signal);
			this.reconcile();
			if (
				controller.signal.aborted ||
				lifetime !== this.lifetime ||
				key !== contextKey(this.context()) ||
				!this.current(process)
			)
				throw new Error("extension result belongs to a revoked runtime or session");
			apply(process, value);
			return value;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.operatorRequests.delete(controller);
			this.changed();
		}
	}

	async invoke(
		invocation: string,
		args: string,
		promptNames: readonly string[] = [],
		signal?: AbortSignal,
	): Promise<ExtensionOutputV2> {
		this.reconcile();
		if (this.closed || !this.options.isIdle() || this.reloading)
			throw new Error("extension command requires an idle session");
		if (Buffer.byteLength(args) > RUNTIME_LIMITS.argumentBytes) throw new Error("extension arguments exceed 16 KiB");
		const row = this.commands(promptNames).find((candidate) => candidate.invocation === invocation);
		if (!row?.available) throw new Error(row?.reason ?? `/${invocation} is not an available extension command`);
		const entry = this.inventory.find(
			(candidate): candidate is ApiV2Extension => isApiV2(candidate) && candidate.id === row.extensionId,
		);
		if (!entry) throw new Error("extension command unavailable");
		const name = invocation.slice(invocation.lastIndexOf(":") + 1);
		return this.operator(
			entry,
			(process, abort) => process.command(name, args, abort),
			(process, output) => this.apply(process, output, "command"),
			signal,
		);
	}

	/** A press on something this extension drew. */
	async action(extensionId: string, event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		const entry = this.runningEntry(extensionId);
		return this.operator(
			entry,
			(process) => process.action(event),
			(process, output) => this.apply(process, output, "action"),
		);
	}

	/** One answered step of an interview this extension started. */
	async interview(extensionId: string, answer: InterviewAnswer): Promise<InterviewNext> {
		const entry = this.runningEntry(extensionId);
		return this.operator(
			entry,
			(process) => process.interview(answer),
			(process, next) => {
				if (!("done" in next)) return;
				const { done: _done, ...output } = next;
				this.apply(process, output, "action");
			},
		);
	}

	private runningEntry(extensionId: string): ApiV2Extension {
		const process = this.processes.get(extensionId);
		if (!process || !this.current(process)) throw new Error(`extension ${extensionId} has no running runtime`);
		return process.extension as ApiV2Extension;
	}

	/**
	 * One awaited hook. Its `ui` is applied like an observation's; its effects
	 * go back to the middleware registration that asked. A runtime that is not
	 * running is an error outcome, so a gate declared `onError: block` stays shut.
	 */
	async hook(
		extensionId: string,
		event: ExtensionHookEvent,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExtensionHookOutcome> {
		const process = this.processes.get(extensionId);
		if (!process || !this.current(process)) return { kind: "error", message: "runtime is not running" };
		const lifetime = this.lifetime;
		try {
			const result = await process.hook(event, timeoutMs, signal);
			if (result.ui && lifetime === this.lifetime) this.apply(process, result.ui, "observation");
			return { kind: "ok", effects: result.effects ?? [] };
		} catch (error) {
			if (error instanceof ExtensionRequestTimeout) return { kind: "timeout" };
			return { kind: "error", message: message(error) };
		}
	}

	/** The operator left the workspace (`/workspace off`, the leader key). */
	leaveWorkspace(): boolean {
		const before = this.surface.activeWorkspace;
		if (!before) return false;
		this.surface.leaveWorkspace();
		this.workspaceMoved(before, null);
		this.changed();
		return true;
	}
	closePanel(extensionId: string): void {
		this.surface.closePanel(extensionId);
	}

	/**
	 * The validated skin of a workspace, read from the runtime's digest-checked
	 * private copy rather than the installed root, so a file changed after
	 * install never paints. Null when the workspace has none or it no longer
	 * validates.
	 */
	skinFor(extensionId: string, workspaceId: string): ExtensionSkin | null {
		const process = this.processes.get(extensionId);
		const file = process?.declaration.workspaces.find((workspace) => workspace.id === workspaceId)?.skin;
		if (!process || !this.current(process) || file === undefined) return null;
		try {
			const checked = validateSkin(JSON.parse(readFileSync(path.join(process.copyRoot, "package", file), "utf8")));
			if (checked.ok) return checked.skin;
			this.report(`extension ${extensionId}: skin ${file} refused: ${checked.path} ${checked.reason}`);
		} catch (error) {
			this.report(`extension ${extensionId}: skin ${file} unreadable: ${message(error)}`);
		}
		return null;
	}

	private apply(
		process: ExtensionRuntimeProcessV2,
		output: Omit<ExtensionOutputV2, "text">,
		origin: OutputOrigin,
	): void {
		if (!this.current(process)) return;
		const before = this.surface.activeWorkspace;
		this.surface.apply(process.extension.id, output, origin, process.declaration.workspaces);
		const after = this.surface.activeWorkspace;
		if (before !== after) this.workspaceMoved(before, after);
		this.changed();
	}
	/** Tell the runtimes involved; each reads `activeWorkspace` from its next snapshot. */
	private workspaceMoved(before: ActiveExtensionWorkspace | null, after: ActiveExtensionWorkspace | null): void {
		const context = this.context();
		for (const id of new Set([before?.extensionId, after?.extensionId])) {
			if (id === undefined) continue;
			this.processes
				.get(id)
				?.updateSnapshot({ ...context, generation: this.generation, activeWorkspace: this.workspaceFor(id) });
		}
		if (before) this.observeOne(before.extensionId, { event: "workspace_leave", workspace: before.workspaceId });
		if (after) this.observeOne(after.extensionId, { event: "workspace_enter", workspace: after.workspaceId });
	}

	/**
	 * Passive delivery to every ready runtime that declared the event, in order
	 * per runtime. Unlike api 1 nothing is coalesced, because usage and file
	 * changes carry data; a runtime that falls far behind loses the oldest.
	 */
	observe(event: ExtensionObservationV2): void {
		if (this.closed) return;
		for (const process of this.processes.values()) this.enqueue(process, event);
	}
	private observeOne(extensionId: string, event: ExtensionObservationV2): void {
		const process = this.processes.get(extensionId);
		if (process) this.enqueue(process, event);
	}
	/**
	 * Ticks and file watches are driven here. A tick is skipped while the
	 * runtime is still working through earlier observations, so a slow handler
	 * sees at most one pending tick rather than a backlog.
	 */
	private arm(process: ExtensionRuntimeProcessV2, workspace: string): void {
		const declared = process.declaration;
		if (declared.tickMs !== undefined && !this.ticks.has(process)) {
			const intervalMs = declared.tickMs;
			const timer = setInterval(() => {
				if (!this.current(process)) return;
				const queue = this.queues.get(process);
				if (queue && (queue.draining || queue.events.some((event) => event.event === "tick"))) return;
				this.enqueue(process, { event: "tick", intervalMs });
			}, intervalMs);
			timer.unref();
			this.ticks.set(process, timer);
		}
		if (declared.watch.length > 0 && declared.events.includes("fs_changed") && !this.watches.has(process))
			this.watches.set(
				process,
				watchExtensionGlobs(workspace, declared.watch, (paths) => this.enqueue(process, { event: "fs_changed", paths })),
			);
	}
	private disarm(process: ExtensionRuntimeProcessV2): void {
		const timer = this.ticks.get(process);
		if (timer) clearInterval(timer);
		this.ticks.delete(process);
		this.watches.get(process)?.close();
		this.watches.delete(process);
	}

	private enqueue(process: ExtensionRuntimeProcessV2, observed: ExtensionObservationV2): void {
		if (process.state !== "ready" || !subscribes(process, observed.event)) return;
		const event = visibleTo(observed, process.declaration.access);
		let queue = this.queues.get(process);
		if (!queue) {
			queue = { events: [], draining: false };
			this.queues.set(process, queue);
		}
		if (queue.events.length >= OBSERVATION_BACKLOG) {
			queue.events.shift();
			this.report(`extension ${process.extension.id} is behind on observations; the oldest was dropped`);
		}
		queue.events.push(event);
		if (!queue.draining) void this.drain(process, queue);
	}
	private async drain(process: ExtensionRuntimeProcessV2, queue: ObservationQueue): Promise<void> {
		queue.draining = true;
		try {
			while (queue.events.length > 0 && this.current(process) && this.queues.get(process) === queue) {
				const event = queue.events.shift() as ExtensionObservationV2;
				const lifetime = this.lifetime;
				try {
					const output = await process.observe(event);
					if (output && lifetime === this.lifetime) this.apply(process, output, "observation");
				} catch (error) {
					this.report(`extension ${process.extension.id}: ${event.event} handler skipped: ${message(error)}`);
				}
			}
		} finally {
			queue.draining = false;
		}
	}

	/** Operator cancel aborts operator requests; the runtimes keep serving. */
	cancel(): void {
		for (const controller of this.operatorRequests) controller.abort();
	}

	async dispose(): Promise<void> {
		this.closed = true;
		this.lifetime++;
		this.cancel();
		this.retireAll("session-closed");
		await this.reloadTask;
		await Promise.allSettled([...this.starting.values()]);
		await Promise.all(this.retired);
		this.surface.reset(() => false);
	}
}
