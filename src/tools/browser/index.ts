import { readFileSync } from "node:fs";
import path from "node:path";
import { prepareBoundedImage } from "../../core/file-references.js";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { ToolNames } from "../../core/tool-names.js";
import { UNTRUSTED_CONTENT_BANNER } from "../../core/untrusted-content.js";
import {
	BrowserComponentUnavailableError,
	browserComponentInstallable,
	installBrowserComponent,
	resolveBrowserComponent,
} from "../../domains/lifecycle/browser-component.js";
import { acceptsImageInput } from "../../domains/providers/image-input.js";
import type { ImageContent } from "../../engine/types.js";
import {
	commitObservationReservation,
	finalizeObservation,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import { readMaxBytes } from "../read.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { imageOmissionNotice } from "../result-shaping.js";
import { byteLength } from "../truncate-utf8.js";
import type { BrowserEventDelta, BrowserReply, BrowserServerState, BrowserViewport } from "./protocol.js";
import { BrowserSessions } from "./session.js";
import {
	BROWSER_OPS,
	type BrowserOp,
	browserGrantedHosts,
	browserHermetic,
	browserOutwardHosts,
	browserToolSurface,
	grantBrowserHosts,
	isLoopbackHost,
	prepareBrowserArguments,
	setBrowserHermetic,
} from "./surface.js";

const RUN_DEFAULT_TIMEOUT_MS = 300_000;
const RUN_MAX_TIMEOUT_MS = 1_800_000;
const SERVE_DEFAULT_TIMEOUT_MS = 120_000;
const OTHER_TIMEOUT_MS = 90_000;

export interface BrowserToolDeps {
	getWorkspaceRoot: () => string;
}

export type BrowserTool = ToolSpec & { closeSessions(): Promise<void> };

function parseViewport(value: unknown): BrowserViewport | null | undefined {
	if (value === undefined) return undefined;
	const m = typeof value === "string" ? /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/u.exec(value) : null;
	return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function eventLines(events: BrowserEventDelta | undefined): string[] {
	if (!events) return [];
	const lines: string[] = [];
	const where = (r: { url?: string; line?: number }) => (r.url ? ` (${r.url}${r.line ? `:${r.line}` : ""})` : "");
	if (events.exceptions.length > 0) {
		lines.push(`exceptions (${events.exceptions.length} new):`);
		for (const e of events.exceptions) lines.push(`  ×${e.count} ${e.text}${where(e)}`);
	}
	if (events.console.length > 0) {
		lines.push(`console errors and warnings (${events.console.length} new):`);
		for (const c of events.console) lines.push(`  ${c.level} ×${c.count} ${c.text}${where(c)}`);
	}
	if (events.failedRequests.length > 0) {
		lines.push(`failed requests (${events.failedRequests.length} new):`);
		for (const r of events.failedRequests)
			lines.push(`  ${r.method} ${r.url} ${r.status ?? r.error} ×${r.count}${r.resource ? ` (${r.resource})` : ""}`);
	}
	if (events.dropped > 0)
		lines.push(`(${events.dropped} more records past the cap; events() in a run script reads them)`);
	if (lines.length === 0) lines.push("no new console errors, exceptions or failed requests");
	return lines;
}

/** A server's state for the reply head: Clio started it, so its log is the project's own output, as bash output is. */
function serverLines(servers: ReadonlyArray<BrowserServerState> | undefined, workspace: string): string[] {
	const lines: string[] = [];
	for (const s of servers ?? []) {
		const where = path.relative(workspace, s.cwd) || ".";
		const ended = s.state === "exited" ? ` (exit ${s.exitCode ?? "?"}${s.signal ? `, ${s.signal}` : ""})` : "";
		const answered = s.readyMs !== undefined ? ` answered after ${s.readyMs} ms` : "";
		lines.push(`server ${s.state}${ended}: ${s.command} (cwd ${where}) · ${s.ready}${answered}`);
		if (s.logTail.length > 0) {
			lines.push(`  log (last ${s.logTail.length} lines):`);
			for (const line of s.logTail) lines.push(`    ${line}`);
		}
	}
	return lines;
}

/** Text first: what Clio ran above the banner, everything the page supplied under it. */
function formatBrowserReply(
	op: BrowserOp,
	reply: BrowserReply,
	notes: ReadonlyArray<string>,
	view: { workspace: string; hermetic: boolean },
): string {
	const head: string[] = [];
	const facts = reply.pageFacts;
	head.push(
		`browser ${op}${facts ? ` page ${facts.page}` : ""}${facts?.status !== undefined ? ` · HTTP ${facts.status}` : ""}${view.hermetic ? " · hermetic" : ""}${reply.ok ? "" : " · FAILED"}`,
	);
	if (reply.closed) head.push(reply.closed === "session" ? "session closed" : "page closed");
	for (const note of notes) head.push(note);
	if (op === "serve" && reply.ok && (reply.servers ?? []).length === 0) head.push("no server is running");
	head.push(...serverLines(reply.servers, view.workspace));
	if (op === "serve" && !reply.ok) head.push(`error: ${reply.error}`);
	if (reply.actions && reply.actions.length > 0) {
		head.push(`actions (${reply.actions.length}):`);
		for (const action of reply.actions) head.push(`  ${action}`);
	}
	if (reply.shots && reply.shots.length > 0) {
		head.push("screenshots:");
		for (const shot of reply.shots) head.push(`  ${shot.path} (${shot.viewport})`);
	}
	const body: string[] = [];
	if (!reply.ok && op !== "serve") body.push(`error: ${reply.error}`);
	if (facts) body.push(`url: ${facts.url}`, `title: ${facts.title}`);
	if (reply.pages && reply.pages.length > 1)
		body.push(`pages: ${reply.pages.map((p) => `${p.page} ${p.url}`).join(" | ")}`);
	if (reply.value !== undefined) body.push(`value: ${reply.value}`);
	if (reply.logs && reply.logs.length > 0) {
		body.push(`console.log (${reply.logs.length}):`);
		for (const line of reply.logs) body.push(`  ${line}`);
	}
	body.push(...eventLines(reply.events));
	const snap = reply.snapshot;
	if (snap) {
		const scope =
			snap.matches !== undefined
				? `${snap.matches} matching node(s)`
				: snap.shownLines < snap.lines
					? `${snap.shownLines} of ${snap.lines} lines${snap.offloadPath ? `; full snapshot in ${snap.offloadPath}` : "; look for more"}`
					: `${snap.lines} lines`;
		body.push(`snapshot (${scope}):`, snap.text);
	}
	if (reply.events === undefined && body.length === 0) return head.join("\n");
	return [...head, UNTRUSTED_CONTENT_BANNER, ...body].join("\n");
}

async function withImages(
	output: string,
	paths: ReadonlyArray<string>,
	details: Record<string, unknown>,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	if (paths.length === 0) return { kind: "ok", output, details };
	if (!acceptsImageInput({ vision: options?.supportsImages }))
		return {
			kind: "ok",
			output: `${output}\n(this route takes no image input: ask the vision tool about a screenshot path)`,
			details,
		};
	const reservation = reserveObservation(readMaxBytes(), options);
	commitObservationReservation(reservation);
	try {
		let budget =
			Math.min(reservation.callCapBytes, options?.toolResultMaxBytes ?? readMaxBytes()) - byteLength(output) - 512;
		const images: ImageContent[] = [];
		for (const file of paths) {
			let bytes: Buffer;
			try {
				bytes = readFileSync(file);
			} catch {
				continue;
			}
			const encoded = budget > 0 ? await prepareBoundedImage(bytes, budget) : null;
			if (encoded === null) continue;
			images.push(encoded);
			budget -= byteLength(encoded.data);
		}
		return finalizeObservation({
			tool: ToolNames.Browser,
			unit: "results",
			output: imageOmissionNotice(paths.length - images.length) + output,
			images,
			shownCount: 1,
			totalCount: 1,
			truncated: false,
			details,
			reservation,
			...(options ? { options } : {}),
		});
	} finally {
		releaseObservation(reservation);
	}
}

export function createBrowserTool(deps: BrowserToolDeps): BrowserTool {
	const sessions = new BrowserSessions();
	return {
		...browserToolSurface,
		closeSessions: () => sessions.closeAll(),
		async run(rawArgs, options): Promise<ToolResult> {
			const args = prepareBrowserArguments(rawArgs);
			const op = args.op as BrowserOp;
			if (!(BROWSER_OPS as ReadonlyArray<string>).includes(op))
				return { kind: "error", message: `browser: op must be one of ${BROWSER_OPS.join(", ")}` };
			const sessionId = options?.sessionId ?? "session";
			if (op === "close" && args.page === undefined && !sessions.has(sessionId))
				return { kind: "ok", output: "browser close: no session was open" };
			const viewport = parseViewport(args.viewport);
			if (viewport === null) return { kind: "error", message: "browser: viewport takes WIDTHxHEIGHT, e.g. 390x844" };
			const url = str(args, "url");
			const workspace = deps.getWorkspaceRoot();
			const hermetic = browserHermetic(args, options?.sessionId);
			if (op === "open") {
				if (url === undefined) return { kind: "error", message: "browser open: url is required" };
				const refusal = options?.flowAdmitsUrl?.(url);
				if (refusal) return { kind: "error", message: `browser open: ${refusal}` };
				const beyond = hermetic ? browserOutwardHosts(args, options?.sessionId, { ignoreGrants: true }) : [];
				if (beyond.length > 0)
					return {
						kind: "error",
						message: `browser open: this browser session is hermetic (loopback only), so ${beyond.join(", ")} is not reachable and nothing was loaded. A hermetic session never grants a host; close the whole session (op=close) and open without hermetic to ask for one.`,
						details: { op, hermetic: true, unreachable: beyond },
					};
			}
			if (op === "run" && str(args, "script") === undefined && str(args, "file") === undefined)
				return { kind: "error", message: "browser run: give script (Playwright JavaScript) or file" };
			const command = str(args, "command");
			const ready = str(args, "ready");
			let serveCwd: string | undefined;
			if (op === "serve" && args.stop !== true && command !== undefined) {
				let readyHost: string | undefined;
				try {
					const parsed = ready !== undefined ? new URL(ready) : undefined;
					if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) readyHost = parsed.hostname;
				} catch {
					// Reported below.
				}
				if (readyHost === undefined || !isLoopbackHost(readyHost))
					return {
						kind: "error",
						message:
							"browser serve: ready is required and must be an http(s) loopback URL the server answers, e.g. http://127.0.0.1:5173/",
					};
			}
			if (op === "serve") {
				try {
					serveCwd = resolveSafeCwd(str(args, "cwd") ?? ".", workspace);
				} catch (error) {
					return {
						kind: "error",
						message: `browser serve: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				if (command === undefined && !sessions.has(sessionId))
					return { kind: "ok", output: "browser serve: no session is open, so no server is running" };
			}

			const notes: string[] = [];
			let component = resolveBrowserComponent();
			if (component === null) {
				if (!browserComponentInstallable())
					return { kind: "error", message: new BrowserComponentUnavailableError().message };
				try {
					options?.onUpdate?.({ kind: "ok", output: "browser: installing the browser component (first use)" });
					component = await installBrowserComponent({
						...(options?.signal ? { signal: options.signal } : {}),
						onProgress: (message) => options?.onUpdate?.({ kind: "ok", output: `browser: ${message}` }),
					});
					notes.push(`installed the browser component at ${component.prefix}`);
				} catch (error) {
					return { kind: "error", message: `browser: ${error instanceof Error ? error.message : String(error)}` };
				}
			}

			// Admission already confirmed these hosts for this call; a hermetic session grants none.
			const newHosts = hermetic ? [] : browserOutwardHosts(args, options?.sessionId);
			if (newHosts.length > 0) grantBrowserHosts(options?.sessionId, newHosts);
			let started: Awaited<ReturnType<BrowserSessions["worker"]>>;
			try {
				started = await sessions.worker({
					sessionId,
					component,
					sandbox: options?.shellSandbox,
					workspace,
					grantedHosts: browserGrantedHosts(options?.sessionId),
					hermetic,
				});
			} catch (error) {
				return {
					kind: "error",
					message: `browser: the session did not start: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (hermetic) setBrowserHermetic(options?.sessionId, true);
			if (started.restarted)
				notes.push(
					hermetic
						? "the session restarted hermetic (loopback only); earlier pages and servers are gone"
						: "the session restarted because this call runs under a different sandbox policy; earlier pages and servers are gone",
				);
			if (hermetic && options?.shellSandbox === undefined && started.fresh)
				notes.push(
					"hermetic without the OS sandbox: pages are held to loopback, but scripts and servers keep the host network",
				);

			const timeoutMs =
				op === "run" || op === "serve"
					? Math.min(
							RUN_MAX_TIMEOUT_MS,
							typeof args.timeout_ms === "number" && args.timeout_ms > 0
								? args.timeout_ms
								: op === "run"
									? RUN_DEFAULT_TIMEOUT_MS
									: SERVE_DEFAULT_TIMEOUT_MS,
						)
					: OTHER_TIMEOUT_MS;
			const page = str(args, "page");
			let reply: BrowserReply;
			try {
				const call = { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: timeoutMs + 5_000 };
				switch (op) {
					case "open":
						reply = await started.worker.request(
							{
								op: "open",
								url: url as string,
								...(page ? { page } : {}),
								...(viewport ? { viewport } : {}),
								grantHosts: browserGrantedHosts(options?.sessionId),
							},
							call,
						);
						break;
					case "run":
						reply = await started.worker.request(
							{
								op: "run",
								...(str(args, "script") !== undefined ? { script: args.script as string } : {}),
								...(str(args, "file") !== undefined ? { file: args.file as string } : {}),
								...(page ? { page } : {}),
								timeoutMs,
							},
							call,
						);
						break;
					case "look":
						reply = await started.worker.request(
							{
								op: "look",
								...(page ? { page } : {}),
								...(str(args, "target") !== undefined ? { target: args.target as string } : {}),
								snapshot: args.snapshot !== false,
								screenshot: args.screenshot === true,
								fullPage: args.full_page === true,
							},
							call,
						);
						break;
					case "serve":
						reply = await started.worker.request(
							{
								op: "serve",
								...(command !== undefined ? { command } : {}),
								...(ready !== undefined ? { ready } : {}),
								...(serveCwd !== undefined ? { cwd: serveCwd } : {}),
								stop: args.stop === true,
								timeoutMs,
							},
							call,
						);
						break;
					case "close":
						if (page === undefined) {
							await sessions.close(sessionId);
							setBrowserHermetic(options?.sessionId, false);
							return { kind: "ok", output: "browser close: session closed; its pages, servers and profile are gone" };
						}
						reply = await started.worker.request({ op: "close", page }, call);
						break;
				}
			} catch (error) {
				return { kind: "error", message: `browser ${op}: ${error instanceof Error ? error.message : String(error)}` };
			}
			const output = formatBrowserReply(op, reply, notes, { workspace, hermetic });
			const details: Record<string, unknown> = {
				op,
				...(reply.pageFacts ? { page: reply.pageFacts.page } : {}),
				...(reply.shots && reply.shots.length > 0 ? { shots: reply.shots.map((shot) => shot.path) } : {}),
				...(reply.servers && reply.servers.length > 0
					? { servers: reply.servers.map((s) => ({ command: s.command, ready: s.ready, state: s.state })) }
					: {}),
				...(hermetic ? { hermetic: true } : {}),
				...(reply.ok ? {} : { failed: true }),
				...(!reply.ok && reply.cancelled ? { cancelled: true } : {}),
				...(!reply.ok && reply.timedOut ? { timedOut: true } : {}),
				...(options?.shellSandbox !== undefined ? { sandboxed: true } : {}),
			};
			if (!reply.ok) return { kind: "error", message: output, details };
			return withImages(
				output,
				(reply.shots ?? []).map((shot) => shot.path),
				details,
				options,
			);
		},
	};
}
