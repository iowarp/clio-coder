import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AcpRequestError } from "./errors.js";
import type { AcpHandshake } from "./server.js";
import type { AcpBootablePeerTransport } from "./transport.js";

export interface DeferredAcpOptions {
	transport: AcpBootablePeerTransport;
	handshake: AcpHandshake;
	launchCwd: string;
	/** The normal orchestrator installs every handler before calling ready. */
	boot(cwd: string, ready: () => void): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalDirectory(value: unknown): string {
	if (typeof value !== "string" || !isAbsolute(value)) {
		throw new AcpRequestError(-32602, "session cwd must be an absolute existing directory", { code: "invalid_params" });
	}
	try {
		const canonical = realpathSync(resolve(value));
		if (statSync(canonical).isDirectory()) return canonical;
	} catch {
		// A missing or unreadable directory is an invalid client request.
	}
	throw new AcpRequestError(-32602, "session cwd must be an absolute existing directory", { code: "invalid_params" });
}

/** Keep the JSON-RPC channel open while the first workspace selects its boot root. */
export async function serveDeferredAcp(options: DeferredAcpOptions): Promise<number> {
	const { transport, handshake } = options;
	const launchCwd = canonicalDirectory(options.launchCwd);
	let boundRoot: string | null = null;
	let readyResolve: (() => void) | null = null;
	let readyReject: ((error: unknown) => void) | null = null;
	let bootStarted = false;
	let bootResult: Promise<number> | null = null;
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		readyResolve = resolveReady;
		readyReject = rejectReady;
	});
	transport.setRequestGuard((method, params) => {
		if (boundRoot === null) return;
		if (!["session/new", "session/load", "session/resume", "session/list"].includes(method)) return;
		const requested = isRecord(params) ? params.cwd : undefined;
		if (method === "session/list" && (requested === undefined || requested === null)) return;
		const root = canonicalDirectory(requested);
		if (root !== boundRoot) {
			throw new AcpRequestError(-32602, `session cwd does not match bound workspace root ${boundRoot}`, {
				code: "session_cwd_mismatch",
			});
		}
	});
	// The first binding request has already entered its handler when this gate
	// is installed. Later requests wait and resume in arrival order.
	const beginBoot = (root: string): void => {
		if (bootStarted) return;
		bootStarted = true;
		boundRoot = root;
		transport.setRequestGate(() => ready);
		try {
			process.chdir(root);
		} catch {
			readyReject?.(new AcpRequestError(-32602, "session cwd cannot be entered", { code: "invalid_params" }));
			return;
		}
		bootResult = options
			.boot(root, () => {
				transport.setFallbackRequestHandler(null);
				transport.setRequestGate(null);
				readyResolve?.();
			})
			.catch((error: unknown) => {
				readyReject?.(error);
				transport.setRequestGate(null);
				throw error;
			});
		// The request handler receives the boot error through ready. The serve
		// promise observes this rejection separately, so it never goes unhandled.
		void bootResult.catch(() => undefined);
	};
	const workspaceRequest = async (method: string, params: unknown): Promise<unknown> => {
		if (!handshake.initialized) {
			throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
		}
		if (handshake.loggedOut) {
			throw new AcpRequestError(-32000, "authentication required", { code: "authentication_required" });
		}
		const requested = isRecord(params) ? params.cwd : undefined;
		const root =
			method === "session/new" || method === "session/load" || method === "session/resume"
				? canonicalDirectory(requested)
				: method === "session/list" && requested !== undefined && requested !== null
					? canonicalDirectory(requested)
					: launchCwd;
		if (boundRoot !== null && root !== boundRoot) {
			throw new AcpRequestError(-32602, `session cwd does not match bound workspace root ${boundRoot}`, {
				code: "session_cwd_mismatch",
			});
		}
		beginBoot(root);
		await ready;
		return await transport.invokeRegistered(method, params);
	};
	transport.onRequest("initialize", (params) => handshake.initialize(params));
	transport.onRequest("authenticate", (params) => handshake.authenticate(params));
	transport.onRequest("logout", (params) => handshake.logout(params));
	for (const method of ["session/new", "session/load", "session/resume", "session/list", "session/delete"] as const) {
		transport.onRequest(method, (params) => workspaceRequest(method, params));
	}
	transport.setFallbackRequestHandler(async (method, params) => {
		if (!bootStarted) {
			if (method.startsWith("session/") || method.startsWith("_clio-coder/")) {
				return await workspaceRequest(method, params);
			}
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		await ready;
		return await transport.invokeRegistered(method, params);
	});
	if (transport.closed) return 0;
	await new Promise<void>((resolveClosed) => transport.onClose(resolveClosed));
	return bootResult === null ? 0 : await bootResult;
}
