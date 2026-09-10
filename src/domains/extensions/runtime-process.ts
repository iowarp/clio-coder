import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import { resolveExtensionEntrypoint } from "./command-schema.js";
import { parseExtensionManifest } from "./discovery.js";
import { extensionContentDigestWithCapture } from "./integrity.js";
import type { ExtensionObservation, ExtensionOutput, ExtensionRuntimeSnapshot } from "./public-api.js";
import { extensionPlainText, parseExtensionOutput, RUNTIME_LIMITS } from "./runtime-schema.js";
import type { ExtensionRuntimeDeclaration, LoadableExtension } from "./types.js";

export type RuntimeProcessState = "staging" | "starting" | "ready" | "failed" | "disposed";
interface Pending {
	id: string;
	resolve(output: ExtensionOutput): void;
	reject(error: Error): void;
	cleanup(): void;
}
/** One process and private package copy; no live host objects cross this boundary. */
export class ExtensionRuntimeProcess {
	readonly instance = randomUUID();
	readonly declaration: ExtensionRuntimeDeclaration;
	readonly copyRoot: string;
	readonly startedAt = performance.now();
	state: RuntimeProcessState = "staging";
	failure: string | undefined;
	readyMs = 0;
	rss = 0;
	private child: ChildProcess;
	private pending: Pending | undefined;
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
	private onState: () => void;
	readonly staged: Promise<void>;

	constructor(
		readonly extension: LoadableExtension,
		readonly snapshot: ExtensionRuntimeSnapshot,
		onState: () => void = () => {},
	) {
		if (!extension.runtime) throw new Error("extension has no operator runtime");
		this.declaration = extension.runtime;
		this.onState = onState;
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
				JSON.stringify(parsed.manifest.runtime) !== JSON.stringify(this.declaration)
			)
				throw new Error("runtime declarations differ from verified manifest bytes");
			resolveExtensionEntrypoint(copy, this.declaration.entrypoint);
		} catch (error) {
			rmSync(temporary, { recursive: true, force: true });
			throw error;
		}
		this.staged = new Promise((resolve, reject) => {
			this.stageResolve = resolve;
			this.stageReject = reject;
		});
		// The parent never forwards child stdout/stderr to a terminal or protocol stream.
		this.child = fork(path.join(resolvePackageRoot(), "src/domains/extensions/runtime-child.mjs"), [], {
			cwd: snapshot.workspace,
			execArgv: [],
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
			snapshot,
		});
	}
	get pid(): number | undefined {
		return this.child.pid;
	}
	get busy(): boolean {
		return this.pending !== undefined;
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
			this.onState();
		} catch {
			/* Observability cannot break process settlement. */
		}
	}
	private send(value: Record<string, unknown>): void {
		if (!this.child.connected) return;
		this.child.send({ protocol: 1, instance: this.instance, ...value }, (error) => {
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
		this.rejectPending(error);
		this.notifyState();
		this.kill("SIGKILL");
	}
	private rejectPending(error: Error): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.cleanup();
		pending?.reject(error);
	}
	private receive(value: unknown): void {
		if (this.state === "disposed" || this.state === "failed") return;
		try {
			if (Date.now() - this.messageWindow > 1000) {
				this.messageWindow = Date.now();
				this.messages = 0;
			}
			if (++this.messages > 128) throw new Error("runtime IPC rate exceeded");
			if (Buffer.byteLength(JSON.stringify(value)) > RUNTIME_LIMITS.messageBytes)
				throw new Error("runtime IPC message too large");
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid runtime IPC message");
			const m = value as Record<string, unknown>;
			const fields: Record<string, string[]> = {
				ready: ["commands", "events", "rss"],
				active: [],
				result: ["id", "output"],
				error: ["id", "error"],
				fatal: ["error"],
			};
			if (
				typeof m.kind !== "string" ||
				!Object.hasOwn(fields, m.kind) ||
				Object.keys(m).some((key) => !["protocol", "instance", "kind", ...(fields[m.kind as string] ?? [])].includes(key))
			)
				throw new Error("invalid runtime protocol fields");
			if (m.protocol !== 1 || m.instance !== this.instance) throw new Error("runtime protocol or instance mismatch");
			if (m.kind === "fatal") throw new Error(typeof m.error === "string" ? m.error : "runtime fatal error");
			if (m.kind === "ready" && this.state === "staging") {
				if (
					JSON.stringify(Array.isArray(m.commands) ? [...m.commands].sort() : null) !==
						JSON.stringify(this.declaration.commands.map((command) => command.name).sort()) ||
					JSON.stringify(Array.isArray(m.events) ? [...m.events].sort() : null) !==
						JSON.stringify([...this.declaration.events].sort())
				)
					throw new Error("runtime registration inventory mismatch");
				if (typeof m.rss !== "number" || !Number.isFinite(m.rss) || m.rss < 0)
					throw new Error("invalid runtime memory observation");
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
			if (m.kind !== "result" && m.kind !== "error") throw new Error("unexpected runtime IPC message");
			// Replies without their exact outstanding request have no authority.
			if (!this.pending || m.id !== this.pending.id || this.state !== "ready") return;
			if (m.kind === "error") throw new Error(typeof m.error === "string" ? m.error : "runtime handler failed");
			const output = parseExtensionOutput(m.output, this.declaration);
			const pending = this.pending;
			this.pending = undefined;
			pending.cleanup();
			pending.resolve(output);
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
	request(
		message: { kind: "command"; name: string; args: string } | { kind: "observe"; observation: ExtensionObservation },
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExtensionOutput> {
		if (this.state !== "ready" || this.pending)
			return Promise.reject(new Error(this.failure ?? "runtime not ready or busy"));
		if (signal?.aborted) return Promise.reject(new Error("extension command cancelled"));
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const cancel = (): void => {
				this.send({ kind: "cancel", id });
				this.rejectPending(new Error("extension command cancelled"));
				void this.dispose("cancelled");
			};
			const timer = setTimeout(() => this.fail("runtime request timed out"), timeoutMs);
			this.pending = {
				id,
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
				},
			};
			signal?.addEventListener("abort", cancel, { once: true });
			this.send({ ...message, id });
		});
	}
	dispose(reason = "disposed"): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.state = "disposed";
		clearTimeout(this.startupTimer);
		const error = new Error(`runtime disposed: ${reason}`);
		this.stageReject(error);
		this.activeReject?.(error);
		this.rejectPending(error);
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
