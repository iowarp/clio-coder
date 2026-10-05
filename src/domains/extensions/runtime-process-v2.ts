import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import { resolveExtensionEntrypoint } from "./command-schema.js";
import { parseExtensionManifest } from "./discovery.js";
import { extensionContentDigestWithCapture } from "./integrity.js";
import type { ExtensionRuntimeDeclarationV2 } from "./manifest-v2.js";
import type {
	ExtensionHookEvent,
	ExtensionHookResult,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionRuntimeSnapshotV2,
	ExtensionToolResult,
	ExtensionUiAction,
} from "./public-api-v2.js";
import {
	type OutputOrigin,
	parseExtensionHookResult,
	parseExtensionOutputV2,
	parseExtensionToolResult,
} from "./runtime-output-v2.js";
import type { RuntimeProcessState } from "./runtime-process.js";
import { extensionPlainText, RUNTIME_LIMITS } from "./runtime-schema.js";
import { RUNTIME_V2_LIMITS } from "./runtime-schema-v2.js";
import type { LoadableExtension } from "./types.js";

/** Host-held values a runtime reaches only by asking: session state and the cross-session store. */
export interface ExtensionKeyValueHost {
	get(scope: "state" | "store", key: string): { value: unknown; version: number };
	set(scope: "state" | "store", key: string, value: unknown, ifVersion?: number): { ok: boolean; version: number };
	delete(scope: "state" | "store", key: string): void;
	keys(scope: "state" | "store"): string[];
}

export interface RuntimeProcessV2Options {
	snapshot: ExtensionRuntimeSnapshotV2;
	/** Resolved values of the manifest's config fields. */
	options: Readonly<Record<string, string | number | boolean>>;
	keyValue: ExtensionKeyValueHost;
	/** The directory the `store` write root names. */
	storeDir: string;
	onState?: () => void;
}

export interface RuntimeRoots {
	bootstrap: string;
	packageCopy: string;
	workspace: string;
	storeDir: string;
	home: string;
}

/** A request the runtime did not answer in time. The runtime stays up; the caller decides what a miss costs. */
export class ExtensionRequestTimeout extends Error {
	constructor(readonly kind: string) {
		super(`extension ${kind} timed out`);
	}
}

const directory = (root: string): string => (root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/**
 * Node permission flags for one runtime, built from what its manifest
 * declares. This is a seat belt against mistakes in code the operator asked
 * for, not a boundary against a hostile package: a package that may run
 * programs can do anything those programs can, and network access is not
 * restricted here at all.
 */
export function runtimePermissionArgs(declaration: ExtensionRuntimeDeclarationV2, roots: RuntimeRoots): string[] {
	const read = new Set([roots.bootstrap, directory(roots.packageCopy), directory(roots.storeDir)]);
	for (const entry of declaration.permissions.fs.read) {
		if (entry === "workspace") read.add(directory(roots.workspace));
		else if (entry === "home") read.add(directory(roots.home));
		else read.add(directory(path.isAbsolute(entry) ? entry : path.join(roots.workspace, entry)));
	}
	const write = new Set([directory(roots.storeDir)]);
	for (const entry of declaration.permissions.fs.write)
		if (entry !== "store") write.add(directory(path.join(roots.workspace, entry)));
	return [
		"--permission",
		...[...read].map((root) => `--allow-fs-read=${root}`),
		...[...write].map((root) => `--allow-fs-write=${root}`),
		...(declaration.permissions.exec ? ["--allow-child-process"] : []),
	];
}

interface Pending {
	kind: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

const REPLY_FIELDS: Record<string, readonly string[]> = {
	ready: ["commands", "events", "hooks", "tools", "actions", "interviews", "rss"],
	active: [],
	result: ["id", "output"],
	error: ["id", "error"],
	fatal: ["error"],
	call: ["id", "op", "key", "value", "ifVersion"],
};

function sameNames(value: unknown, expected: readonly string[]): boolean {
	return Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

/** One api 2 runtime: a process, a private package copy and the requests in flight. No live host object crosses. */
export class ExtensionRuntimeProcessV2 {
	readonly instance = randomUUID();
	readonly declaration: ExtensionRuntimeDeclarationV2;
	readonly copyRoot: string;
	readonly startedAt = performance.now();
	/** Node cannot restrict sockets here, so a `net: false` declaration is recorded as unenforced. */
	readonly netEnforced = false;
	state: RuntimeProcessState = "staging";
	failure: string | undefined;
	readyMs = 0;
	rss = 0;
	actions: readonly string[] = [];
	interviews: readonly string[] = [];
	readonly staged: Promise<void>;
	private child: ChildProcess;
	private pending = new Map<string, Pending>();
	private stageResolve!: () => void;
	private stageReject!: (error: Error) => void;
	private activeResolve: (() => void) | undefined;
	private activeReject: ((error: Error) => void) | undefined;
	private startupTimer: ReturnType<typeof setTimeout>;
	private stopPromise: Promise<void> | undefined;
	private exited: Promise<void>;
	private diagnosticBytes = 0;
	private messageWindow = Date.now();
	private messages = 0;

	constructor(
		readonly extension: LoadableExtension,
		private readonly options: RuntimeProcessV2Options,
	) {
		if (!extension.runtimeV2) throw new Error("extension has no api 2 runtime");
		this.declaration = extension.runtimeV2;
		const temporary = mkdtempSync(path.join(os.tmpdir(), "clio-coder-extension-"));
		this.copyRoot = temporary;
		const copy = path.join(temporary, "package");
		try {
			cpSync(extension.provenance.canonicalRoot, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
			const manifestName = path.basename(extension.manifestPath);
			const verified = extensionContentDigestWithCapture(copy, { capture: [manifestName] });
			if (verified.digest !== extension.provenance.contentDigest)
				throw new Error("runtime copy does not match installed package digest");
			const manifestBytes = verified.captured.get(manifestName);
			if (!manifestBytes) throw new Error("verified runtime manifest bytes are absent");
			const parsed = parseExtensionManifest(
				manifestName.endsWith(".json")
					? JSON.parse(manifestBytes.toString("utf8"))
					: parseYaml(manifestBytes.toString("utf8")),
				path.join(copy, manifestName),
			);
			if (
				!parsed.manifest ||
				parsed.diagnostics.some((diagnostic) => diagnostic.type === "error") ||
				parsed.manifest.id !== extension.id ||
				JSON.stringify(parsed.manifest.runtimeV2) !== JSON.stringify(this.declaration)
			)
				throw new Error("runtime declarations differ from verified manifest bytes");
			resolveExtensionEntrypoint(copy, this.declaration.entrypoint);
			mkdirSync(options.storeDir, { recursive: true });
		} catch (error) {
			rmSync(temporary, { recursive: true, force: true });
			throw error;
		}
		this.staged = new Promise((resolve, reject) => {
			this.stageResolve = resolve;
			this.stageReject = reject;
		});
		// A rejected stage is reported through `failure`; a caller that never awaits it must not crash the host.
		this.staged.catch(() => {});
		const bootstrap = path.join(resolvePackageRoot(), "src/domains/extensions/runtime-child-v2.mjs");
		// The parent never forwards child stdout/stderr to a terminal or protocol stream.
		this.child = fork(bootstrap, [], {
			cwd: options.snapshot.workspace,
			execArgv: runtimePermissionArgs(this.declaration, {
				bootstrap,
				packageCopy: copy,
				workspace: options.snapshot.workspace,
				storeDir: options.storeDir,
				home: os.homedir(),
			}),
			env: buildSafeToolEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			serialization: "json",
		});
		this.exited = new Promise((resolve) => {
			this.child.once("exit", () => {
				this.kill("SIGKILL"); // Also settle non-detached descendants after a cooperative parent exits.
				if (this.state !== "disposed") this.fail("runtime process exited");
				this.cleanCopy();
				resolve();
			});
			this.child.once("error", (error) => {
				this.fail(`runtime process error: ${error.message}`);
				if (!this.child.pid) {
					this.cleanCopy();
					resolve();
				}
			});
		});
		this.startupTimer = setTimeout(() => this.fail("runtime startup timed out"), RUNTIME_LIMITS.startupMs);
		this.child.on("message", (message) => this.receive(message));
		const diagnostic = (chunk: Buffer): void => {
			this.diagnosticBytes += chunk.byteLength;
			if (this.diagnosticBytes > RUNTIME_LIMITS.diagnosticsBytes) this.fail("runtime diagnostic output exceeded 64 KiB");
		};
		this.child.stdout?.on("data", diagnostic);
		this.child.stderr?.on("data", diagnostic);
		this.send({
			kind: "init",
			entrypoint: path.join(copy, this.declaration.entrypoint),
			declaration: this.declaration,
			snapshot: options.snapshot,
			options: options.options,
		});
	}
	get pid(): number | undefined {
		return this.child.pid;
	}
	get busy(): boolean {
		return this.pending.size > 0;
	}
	private cleanCopy(): void {
		try {
			rmSync(this.copyRoot, { recursive: true, force: true });
		} catch (error) {
			this.failure = `runtime private-copy cleanup failed: ${extensionPlainText(String(error)).slice(0, 400)}`;
			this.notifyState();
		}
	}
	private notifyState(): void {
		try {
			this.options.onState?.();
		} catch {
			/* Observability cannot break process settlement. */
		}
	}
	private send(value: Record<string, unknown>): void {
		if (!this.child.connected) return;
		this.child.send({ protocol: 2, instance: this.instance, ...value }, (error) => {
			if (error) this.fail(`runtime IPC failed: ${error.message}`);
		});
	}
	private kill(signal: NodeJS.Signals): void {
		if (this.child.pid && process.platform !== "win32") {
			try {
				process.kill(-this.child.pid, signal);
				return;
			} catch {
				/* Direct-child fallback. */
			}
		}
		this.child.kill(signal);
	}
	private fail(reason: string): void {
		if (this.state === "disposed" || this.state === "failed") return;
		this.failure = extensionPlainText(reason).slice(0, 512);
		this.state = "failed";
		clearTimeout(this.startupTimer);
		const error = new Error(this.failure);
		this.stageReject(error);
		this.activeReject?.(error);
		this.rejectAll(error);
		this.notifyState();
		this.kill("SIGKILL");
	}
	private rejectAll(error: Error): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) {
			entry.cleanup();
			entry.reject(error);
		}
	}
	private settle(id: unknown): Pending | undefined {
		if (typeof id !== "string") return undefined;
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		pending.cleanup();
		return pending;
	}
	/** State and store live here, so a reload swaps the process and loses nothing. */
	private serveCall(m: Record<string, unknown>): void {
		const reply = (body: Record<string, unknown>): void => this.send({ kind: "returned", id: m.id, ...body });
		try {
			const [scope, verb] = String(m.op).split(".");
			if ((scope !== "state" && scope !== "store") || typeof m.id !== "string") throw new Error("unsupported host call");
			if (!(scope === "state" ? this.declaration.state.session : this.declaration.state.store))
				throw new Error(`runtime did not declare ${scope}`);
			const host = this.options.keyValue;
			if (verb === "keys") return reply({ value: host.keys(scope) });
			if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > 200) throw new Error("invalid key");
			if (verb === "get") return reply({ value: host.get(scope, m.key) });
			if (verb === "delete") return reply({ value: (host.delete(scope, m.key), null) });
			if (verb !== "set") throw new Error("unsupported host call");
			if (m.ifVersion !== undefined && !Number.isInteger(m.ifVersion)) throw new Error("invalid version");
			reply({ value: host.set(scope, m.key, m.value, m.ifVersion as number | undefined) });
		} catch (error) {
			reply({ error: extensionPlainText(error instanceof Error ? error.message : String(error)).slice(0, 512) });
		}
	}
	private receive(value: unknown): void {
		if (this.state === "disposed" || this.state === "failed") return;
		try {
			if (Date.now() - this.messageWindow > 1000) {
				this.messageWindow = Date.now();
				this.messages = 0;
			}
			if (++this.messages > RUNTIME_V2_LIMITS.messagesPerSecond) throw new Error("runtime IPC rate exceeded");
			if (Buffer.byteLength(JSON.stringify(value)) > RUNTIME_V2_LIMITS.messageBytes)
				throw new Error("runtime IPC message too large");
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid runtime IPC message");
			const m = value as Record<string, unknown>;
			const fields = typeof m.kind === "string" ? REPLY_FIELDS[m.kind] : undefined;
			if (!fields || Object.keys(m).some((key) => !["protocol", "instance", "kind", ...fields].includes(key)))
				throw new Error("invalid runtime protocol fields");
			if (m.protocol !== 2 || m.instance !== this.instance) throw new Error("runtime protocol or instance mismatch");
			if (m.kind === "fatal") throw new Error(typeof m.error === "string" ? m.error : "runtime fatal error");
			if (m.kind === "ready" && this.state === "staging") {
				const declared = this.declaration;
				const events = [...declared.events, ...(declared.tickMs !== undefined ? ["tick"] : [])];
				if (
					!sameNames(
						m.commands,
						declared.commands.map((command) => command.name),
					) ||
					!sameNames(m.events, events) ||
					!sameNames(m.hooks, [...new Set(declared.hooks.map((hook) => hook.on))]) ||
					!sameNames(
						m.tools,
						declared.tools.map((tool) => tool.name),
					)
				)
					throw new Error("runtime registration inventory mismatch");
				if (
					!Array.isArray(m.actions) ||
					!Array.isArray(m.interviews) ||
					[...m.actions, ...m.interviews].some((name) => typeof name !== "string")
				)
					throw new Error("invalid runtime registration inventory");
				if (typeof m.rss !== "number" || !Number.isFinite(m.rss) || m.rss < 0)
					throw new Error("invalid runtime memory observation");
				this.actions = m.actions as string[];
				this.interviews = m.interviews as string[];
				this.rss = m.rss;
				this.readyMs = performance.now() - this.startedAt;
				this.state = "starting";
				clearTimeout(this.startupTimer);
				this.stageResolve();
				return;
			}
			if (m.kind === "active" && this.state === "starting" && this.activeResolve) {
				this.state = "ready";
				clearTimeout(this.startupTimer);
				this.activeResolve();
				this.activeResolve = undefined;
				this.activeReject = undefined;
				this.notifyState();
				return;
			}
			if (this.state !== "ready") throw new Error("unexpected runtime IPC message");
			if (m.kind === "call") return this.serveCall(m);
			if (m.kind !== "result" && m.kind !== "error") throw new Error("unexpected runtime IPC message");
			// A reply without its outstanding request has no authority: it was cancelled or timed out.
			const pending = this.settle(m.id);
			if (!pending) return;
			if (m.kind === "error")
				pending.reject(
					new Error(extensionPlainText(typeof m.error === "string" ? m.error : "handler failed").slice(0, 512)),
				);
			else pending.resolve(m.output);
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}
	async activate(): Promise<void> {
		await this.staged;
		if (this.state !== "starting") throw new Error(this.failure ?? "runtime is not staged");
		return new Promise((resolve, reject) => {
			this.activeResolve = resolve;
			this.activeReject = reject;
			this.startupTimer = setTimeout(() => this.fail("runtime activation timed out"), RUNTIME_LIMITS.startupMs);
			this.send({ kind: "activate" });
		});
	}
	/** The active workspace and generation change without a restart; handlers read the latest on their next request. */
	updateSnapshot(snapshot: ExtensionRuntimeSnapshotV2): void {
		if (this.state === "ready") this.send({ kind: "snapshot", snapshot });
	}
	private request<T>(
		message: Record<string, unknown> & { kind: string },
		timeoutMs: number,
		parse: (output: unknown) => T,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.state !== "ready") return Promise.reject(new Error(this.failure ?? "runtime not ready"));
		if (this.pending.size >= RUNTIME_V2_LIMITS.concurrentRequests) return Promise.reject(new Error("runtime is busy"));
		if (signal?.aborted) return Promise.reject(new Error(`extension ${message.kind} cancelled`));
		return new Promise<T>((resolve, reject) => {
			const id = randomUUID();
			const abandon = (error: Error): void => {
				if (!this.settle(id)) return;
				this.send({ kind: "cancel", id });
				reject(error);
			};
			const cancel = (): void => abandon(new Error(`extension ${message.kind} cancelled`));
			const timer = setTimeout(() => abandon(new ExtensionRequestTimeout(message.kind)), timeoutMs);
			this.pending.set(id, {
				kind: message.kind,
				resolve: (output) => {
					// A handler that answers outside its contract fails that answer, not the runtime.
					try {
						resolve(parse(output));
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				},
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
				},
			});
			signal?.addEventListener("abort", cancel, { once: true });
			this.send({ ...message, id });
		});
	}
	private output(origin: OutputOrigin): (value: unknown) => ExtensionOutputV2 {
		return (value) => parseExtensionOutputV2(value, this.declaration, origin);
	}
	command(name: string, args: string, signal?: AbortSignal): Promise<ExtensionOutputV2> {
		const declared = this.declaration.commands.find((command) => command.name === name);
		if (!declared) return Promise.reject(new Error(`runtime declares no command '${name}'`));
		return this.request({ kind: "command", name, args }, declared.timeoutMs, this.output("command"), signal);
	}
	observe(event: ExtensionObservationV2): Promise<ExtensionOutputV2 | undefined> {
		return this.request({ kind: "observe", event }, RUNTIME_V2_LIMITS.observationMs, (value) =>
			value === null || value === undefined ? undefined : this.output("observation")(value),
		);
	}
	hook(event: ExtensionHookEvent, timeoutMs: number, signal?: AbortSignal): Promise<ExtensionHookResult> {
		return this.request(
			{ kind: "hook", event },
			timeoutMs,
			(value) => parseExtensionHookResult(value, this.declaration, event.point),
			signal,
		);
	}
	tool(name: string, input: unknown, signal?: AbortSignal): Promise<ExtensionToolResult> {
		const declared = this.declaration.tools.find((tool) => tool.name === name);
		if (!declared) return Promise.reject(new Error(`runtime declares no tool '${name}'`));
		return this.request(
			{ kind: "tool", name, input },
			declared.timeoutMs,
			(value) => parseExtensionToolResult(value, this.declaration),
			signal,
		);
	}
	action(event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		if (!this.actions.includes(event.id)) return Promise.reject(new Error(`runtime registered no action '${event.id}'`));
		return this.request(
			{ kind: "action", name: event.id, event },
			RUNTIME_V2_LIMITS.observationMs,
			this.output("action"),
		);
	}
	dispose(reason = "disposed"): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.state = "disposed";
		clearTimeout(this.startupTimer);
		const error = new Error(`runtime disposed: ${reason}`);
		this.stageReject(error);
		this.activeReject?.(error);
		this.rejectAll(error);
		this.notifyState();
		this.send({ kind: "dispose", reason });
		this.stopPromise = (async () => {
			const timer = setTimeout(() => this.kill("SIGKILL"), RUNTIME_LIMITS.disposeMs);
			await this.exited;
			clearTimeout(timer);
		})();
		return this.stopPromise;
	}
}
