import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MainSandboxPolicy } from "../../core/sandbox/main-session.js";
import { UNTRUSTED_CONTENT_BANNER } from "../../core/untrusted-content.js";
import { BROWSER_INSTALL_COMMAND, resolveBrowserComponent } from "../../domains/lifecycle/browser-component.js";
import type {
	BrowserConsoleRecord,
	BrowserEventDelta,
	BrowserReply,
	BrowserRequestRecord,
	BrowserServerState,
} from "../browser/protocol.js";
import { BrowserSessions } from "../browser/session.js";
import { BROWSER_CHECK_DEFAULT_ASSERTIONS, type BrowserCheckAssertion, type DeclaredCheck } from "./catalog.js";

/**
 * The `browser` check kind: the check's command starts as a dev server inside a hermetic browser session, the page
 * loads once the ready URL answers, an optional step module runs against it, and the declared assertions judge what
 * the page reported. Contained, the session runs in the sandbox with no network namespace but its own loopback;
 * uncontained, the page alone is held to loopback. The session, its server and its profile end with the check.
 */

const LIST_CAP = 12;

export interface BrowserCheckAssertionResult {
	name: BrowserCheckAssertion;
	passed: boolean;
	count: number;
}

/** What `details.browserReport` carries; closed words and counts beside the rendered summary. */
export interface BrowserCheckReport {
	kind: "browser";
	passed: boolean;
	url: string;
	status?: number;
	/** `namespace`: no network beyond a private loopback. `routes`: only the page is held to loopback. */
	hermetic: "namespace" | "routes";
	loaded: boolean;
	steps?: { file: string; passed: boolean; actions: number };
	assertions: BrowserCheckAssertionResult[];
	durationMs: number;
}

export type BrowserCheckOutcome =
	| { kind: "unavailable"; message: string }
	| { kind: "not-started"; message: string; summary: string }
	| { kind: "judged"; report: BrowserCheckReport; summary: string };

export interface BrowserCheckOptions {
	signal?: AbortSignal;
	shellSandbox?: MainSandboxPolicy;
	workspaceRoot: string;
}

/** The argv as one shell line for `serve`: each word quoted unless it is plainly safe. */
function shellLine(argv: ReadonlyArray<string>): string {
	return argv
		.map((word) => {
			if (/^[\w@%+=:,./-]+$/u.test(word)) return word;
			return process.platform === "win32" ? `"${word.replaceAll('"', '\\"')}"` : `'${word.replaceAll("'", "'\\''")}'`;
		})
		.join(" ");
}

function emptyDelta(): BrowserEventDelta {
	return { console: [], exceptions: [], failedRequests: [], dropped: 0 };
}

function merge(into: BrowserEventDelta, reply: BrowserReply): void {
	const events = reply.events;
	if (!events) return;
	into.console.push(...events.console);
	into.exceptions.push(...events.exceptions);
	into.failedRequests.push(...events.failedRequests);
	into.dropped += events.dropped;
}

function total(records: ReadonlyArray<{ count: number }>): number {
	return records.reduce((sum, record) => sum + record.count, 0);
}

function where(record: { url?: string; line?: number }): string {
	return record.url ? ` (${record.url}${record.line ? `:${record.line}` : ""})` : "";
}

function serverLine(server: BrowserServerState | undefined): string[] {
	if (!server) return [];
	const lines = [
		`server: ${server.command} · ${server.state}${server.readyMs !== undefined ? ` · ${server.ready} answered after ${server.readyMs} ms` : ` · waiting for ${server.ready}`}`,
	];
	if (server.state !== "ready" && server.logTail.length > 0) {
		lines.push(`server log (last ${server.logTail.length} lines):`);
		for (const line of server.logTail) lines.push(`  ${line}`);
	}
	return lines;
}

/** The step module's directory may not be the check's cwd; the axe package resolves from the check's cwd. */
function resolveAxe(cwd: string): string | null {
	try {
		return createRequire(path.join(cwd, "package.json")).resolve("@axe-core/playwright");
	} catch {
		return null;
	}
}

function axeScript(entry: string): string {
	return [
		`const m = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
		"const AxeBuilder = m.default?.default ?? m.default ?? m.AxeBuilder;",
		"const result = await new AxeBuilder({ page }).analyze();",
		"return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));",
	].join("\n");
}

interface AxeViolation {
	id: string;
	impact?: string;
	help?: string;
	nodes: number;
}

export async function runBrowserCheck(
	check: DeclaredCheck,
	cwd: string,
	options: BrowserCheckOptions,
): Promise<BrowserCheckOutcome> {
	const spec = check.browser;
	if (spec === undefined) return { kind: "unavailable", message: "the check has kind browser without its parameters" };
	const assertions = spec.assert ?? [...BROWSER_CHECK_DEFAULT_ASSERTIONS];
	const component = resolveBrowserComponent();
	if (component === null)
		return {
			kind: "unavailable",
			message: `the browser component is not installed; the operator provisions it with ${BROWSER_INSTALL_COMMAND}`,
		};
	const axeEntry = assertions.includes("axe") ? resolveAxe(cwd) : null;
	if (assertions.includes("axe") && axeEntry === null)
		return {
			kind: "unavailable",
			message: `assert names axe, but @axe-core/playwright does not resolve from ${path.relative(options.workspaceRoot, cwd) || "."}; add it to the project's dev dependencies`,
		};
	const started = Date.now();
	const deadline = started + check.timeoutMs;
	const remaining = (): number => Math.max(1_000, deadline - Date.now());
	const call = (): { signal?: AbortSignal; timeoutMs: number } => ({
		...(options.signal ? { signal: options.signal } : {}),
		timeoutMs: remaining() + 5_000,
	});
	const hermetic = options.shellSandbox !== undefined ? "namespace" : "routes";
	const sessions = new BrowserSessions();
	const head: string[] = [];
	const body: string[] = [];
	try {
		let worker: Awaited<ReturnType<BrowserSessions["worker"]>>["worker"];
		try {
			({ worker } = await sessions.worker({
				sessionId: `verify-${check.id}-${process.pid}-${started}`,
				component,
				sandbox: options.shellSandbox,
				workspace: options.workspaceRoot,
				grantedHosts: [],
				hermetic: true,
			}));
		} catch (error) {
			return {
				kind: "unavailable",
				message: `the browser session did not start: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const ready = spec.ready ?? spec.url;
		const served = await worker.request(
			{ op: "serve", command: shellLine(check.command), ready, cwd, stop: false, timeoutMs: remaining() },
			call(),
		);
		const server = served.servers?.[0];
		head.push(...serverLine(server));
		if (!served.ok)
			return {
				kind: "not-started",
				message: served.error,
				summary: [`browser check '${check.id}': NOT RUN: ${served.error}`, ...head].join("\n"),
			};
		const events = emptyDelta();
		const opened = await worker.request({ op: "open", url: spec.url }, call());
		merge(events, opened);
		const status = opened.pageFacts?.status;
		head.push(`page: ${spec.url}${status !== undefined ? ` · HTTP ${status}` : ""}${opened.ok ? "" : " · load failed"}`);
		if (!opened.ok) body.push(`load error: ${opened.error}`);
		if (opened.pageFacts?.title) body.push(`title: ${opened.pageFacts.title}`);
		let steps: BrowserCheckReport["steps"];
		if (opened.ok && spec.steps !== undefined) {
			const ran = await worker.request({ op: "run", file: spec.steps, timeoutMs: remaining() }, call());
			merge(events, ran);
			steps = { file: spec.steps, passed: ran.ok, actions: ran.actions?.length ?? 0 };
			head.push(`steps: ${spec.steps} ${ran.ok ? "ok" : "FAILED"} (${steps.actions} actions)`);
			if (!ran.ok) {
				body.push(`steps error: ${ran.error}`);
				for (const action of (ran.actions ?? []).slice(-LIST_CAP)) body.push(`  ${action}`);
			}
		}
		let violations: AxeViolation[] | undefined;
		if (opened.ok && axeEntry !== null) {
			const scanned = await worker.request({ op: "run", script: axeScript(axeEntry), timeoutMs: remaining() }, call());
			merge(events, scanned);
			if (scanned.ok && scanned.value !== undefined) {
				try {
					violations = JSON.parse(scanned.value) as AxeViolation[];
				} catch {
					body.push("axe: the scan returned no readable result");
				}
			} else if (!scanned.ok) body.push(`axe error: ${scanned.error}`);
		}
		const consoleErrors = events.console.filter((record) => record.level === "error");
		const results: BrowserCheckAssertionResult[] = assertions.map((name) => {
			const count =
				name === "console"
					? total(consoleErrors)
					: name === "exceptions"
						? total(events.exceptions)
						: name === "requests"
							? total(events.failedRequests)
							: (violations?.length ?? Number.NaN);
			return { name, passed: count === 0, count };
		});
		const passed = opened.ok && (steps?.passed ?? true) && results.every((result) => result.passed);
		for (const result of results)
			head.push(
				`${result.passed ? "pass" : "FAIL"} ${result.name}: ${Number.isNaN(result.count) ? "not judged" : result.count}`,
			);
		const list = (label: string, records: ReadonlyArray<BrowserConsoleRecord>): void => {
			if (records.length === 0) return;
			body.push(`${label}:`);
			for (const r of records.slice(0, LIST_CAP)) body.push(`  ×${r.count} ${r.text}${where(r)}`);
		};
		list("console errors", consoleErrors);
		list(
			"console warnings",
			events.console.filter((record) => record.level !== "error"),
		);
		list("exceptions", events.exceptions);
		if (events.failedRequests.length > 0) {
			body.push("failed requests:");
			for (const r of events.failedRequests.slice(0, LIST_CAP) as BrowserRequestRecord[])
				body.push(`  ${r.method} ${r.url} ${r.status ?? r.error} ×${r.count}`);
		}
		if (violations && violations.length > 0) {
			body.push("axe violations:");
			for (const v of violations.slice(0, LIST_CAP))
				body.push(`  ${v.id} (${v.impact ?? "unknown"}, ${v.nodes} nodes): ${v.help ?? ""}`);
		}
		const report: BrowserCheckReport = {
			kind: "browser",
			passed,
			url: spec.url,
			...(status !== undefined ? { status } : {}),
			hermetic,
			loaded: opened.ok,
			...(steps !== undefined ? { steps } : {}),
			assertions: results,
			durationMs: Date.now() - started,
		};
		const reach =
			hermetic === "namespace"
				? "hermetic: private loopback, no other network"
				: "hermetic: page held to loopback (no OS sandbox for this call)";
		const summary = [
			`browser check '${check.id}': ${passed ? "passed" : "FAILED"} (${reach})`,
			...head,
			...(body.length > 0 ? [UNTRUSTED_CONTENT_BANNER, ...body] : []),
		].join("\n");
		return { kind: "judged", report, summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			kind: "not-started",
			message,
			summary: [`browser check '${check.id}': NOT RUN: ${message}`, ...head].join("\n"),
		};
	} finally {
		await sessions.closeAll();
	}
}
