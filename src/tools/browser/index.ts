import { readFileSync } from "node:fs";
import { prepareBoundedImage } from "../../core/file-references.js";
import { ToolNames } from "../../core/tool-names.js";
import { DISPLAY_IMAGES_MAX_CHARS, MAX_DISPLAY_IMAGES, type ToolResultImage } from "../../core/tool-result-images.js";
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
import type { BrowserEventDelta, BrowserReply, BrowserViewport } from "./protocol.js";
import { BrowserSessions } from "./session.js";
import {
	BROWSER_OPS,
	type BrowserOp,
	browserGrantedHosts,
	browserOutwardHosts,
	browserToolSurface,
	grantBrowserHosts,
	prepareBrowserArguments,
} from "./surface.js";

const RUN_DEFAULT_TIMEOUT_MS = 300_000;
const RUN_MAX_TIMEOUT_MS = 1_800_000;
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

/** Text first: what Clio ran above the banner, everything the page supplied under it. */
function formatBrowserReply(op: BrowserOp, reply: BrowserReply, notes: ReadonlyArray<string> = []): string {
	const head: string[] = [];
	const facts = reply.pageFacts;
	head.push(
		`browser ${op}${facts ? ` page ${facts.page}` : ""}${facts?.status !== undefined ? ` · HTTP ${facts.status}` : ""}${reply.ok ? "" : " · FAILED"}`,
	);
	if (reply.closed) head.push(reply.closed === "session" ? "session closed" : "page closed");
	for (const note of notes) head.push(note);
	if (reply.actions && reply.actions.length > 0) {
		head.push(`actions (${reply.actions.length}):`);
		for (const action of reply.actions) head.push(`  ${action}`);
	}
	if (reply.shots && reply.shots.length > 0) {
		head.push("screenshots:");
		for (const shot of reply.shots) head.push(`  ${shot.path} (${shot.viewport})`);
	}
	const body: string[] = [];
	if (!reply.ok) body.push(`error: ${reply.error}`);
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

/**
 * Downscaled copies of a call's screenshots for people to look at (ACP clients, the GUI tool card, the terminal card),
 * within {@link DISPLAY_IMAGES_MAX_CHARS} of base64 together. They ride on `details.displayImages`, never on the
 * result's images, so a route that takes no image input sends the model none, and they cost the observation pool
 * nothing.
 */
async function displayCopies(paths: ReadonlyArray<string>): Promise<ToolResultImage[]> {
	const files = paths.slice(0, MAX_DISPLAY_IMAGES);
	let budget = DISPLAY_IMAGES_MAX_CHARS;
	const copies: ToolResultImage[] = [];
	for (const [index, file] of files.entries()) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(file);
		} catch {
			continue;
		}
		const encoded = await prepareBoundedImage(bytes, Math.floor(budget / (files.length - index)));
		if (encoded === null) continue;
		copies.push({ mimeType: encoded.mimeType, data: encoded.data });
		budget -= encoded.data.length;
	}
	return copies;
}

export async function browserResultWithShots(
	output: string,
	paths: ReadonlyArray<string>,
	details: Record<string, unknown>,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	if (paths.length === 0) return { kind: "ok", output, details };
	if (!acceptsImageInput({ vision: options?.supportsImages })) {
		const displayImages = await displayCopies(paths);
		return {
			kind: "ok",
			output: `${output}\n(this route takes no image input: ask the vision tool about a screenshot path)`,
			details: displayImages.length > 0 ? { ...details, displayImages } : details,
		};
	}
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
			if (op === "open") {
				if (url === undefined) return { kind: "error", message: "browser open: url is required" };
				const refusal = options?.flowAdmitsUrl?.(url);
				if (refusal) return { kind: "error", message: `browser open: ${refusal}` };
			}
			if (op === "run" && str(args, "script") === undefined && str(args, "file") === undefined)
				return { kind: "error", message: "browser run: give script (Playwright JavaScript) or file" };

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

			// Admission already confirmed these hosts for this call.
			const newHosts = browserOutwardHosts(args, options?.sessionId);
			if (newHosts.length > 0) grantBrowserHosts(options?.sessionId, newHosts);
			let started: Awaited<ReturnType<BrowserSessions["worker"]>>;
			try {
				started = await sessions.worker({
					sessionId,
					component,
					sandbox: options?.shellSandbox,
					workspace: deps.getWorkspaceRoot(),
					grantedHosts: browserGrantedHosts(options?.sessionId),
				});
			} catch (error) {
				return {
					kind: "error",
					message: `browser: the session did not start: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (started.restarted)
				notes.push("the session restarted because this call runs under a different sandbox policy; earlier pages are gone");

			const timeoutMs =
				op === "run"
					? Math.min(
							RUN_MAX_TIMEOUT_MS,
							typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : RUN_DEFAULT_TIMEOUT_MS,
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
					case "close":
						if (page === undefined) {
							await sessions.close(sessionId);
							return { kind: "ok", output: "browser close: session closed; its pages and profile are gone" };
						}
						reply = await started.worker.request({ op: "close", page }, call);
						break;
				}
			} catch (error) {
				return { kind: "error", message: `browser ${op}: ${error instanceof Error ? error.message : String(error)}` };
			}
			const output = formatBrowserReply(op, reply, notes);
			const details: Record<string, unknown> = {
				op,
				...(reply.pageFacts ? { page: reply.pageFacts.page } : {}),
				...(reply.shots && reply.shots.length > 0 ? { shots: reply.shots.map((shot) => shot.path) } : {}),
				...(reply.ok ? {} : { failed: true }),
				...(!reply.ok && reply.cancelled ? { cancelled: true } : {}),
				...(!reply.ok && reply.timedOut ? { timedOut: true } : {}),
				...(options?.shellSandbox !== undefined ? { sandboxed: true } : {}),
			};
			if (!reply.ok) return { kind: "error", message: output, details };
			return browserResultWithShots(
				output,
				(reply.shots ?? []).map((shot) => shot.path),
				details,
				options,
			);
		},
	};
}
