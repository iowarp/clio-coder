import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimStatuses, contradictionConditions, supersedeConditions } from "./edges.js";
import { type ClaimsLogRead, claimsLogPath, claimsProjectRoot, readClaims } from "./store.js";
import type { ClaimEdgeRecord, ClaimRecord, ClaimStatus } from "./types.js";

/**
 * Delivery of contested and superseded claims to the main agent when the task touches their check (#406).
 *
 * The text goes only into the message tail: a turn_start reminder that the next accepted prompt flushes as a
 * `<system-reminder>` block, or a note on the tool result being appended. The system prompt and tool schemas never
 * vary with it, so the provider prefix cache holds.
 *
 * "Touches" is decided from typed signals only, never by a model: a check id or a path from a claim's keys named as a
 * whole token in the user's task text, a `verify` call naming the check, or a read, edit or write of a path the check's
 * keys or command name. Each check's state is offered at most once per session and again only when that state changes.
 * Workers get none: only the main session registers these hooks, and the dispatch contract carries no claims.
 */

export const CLAIMS_DELIVERY_REGISTRATION_ID = "observer.claims-delivery";
export const CLAIMS_DELIVERY_VERIFY_REGISTRATION_ID = "observer.claims-delivery-verify";

/** Per check message cap and per hook check cap, so one hook point adds at most about 2.4 KB. */
export const CLAIMS_DELIVERY_MAX_CHARS = 1200;
export const CLAIMS_DELIVERY_MAX_CHECKS = 2;
const CLAIM_TEXT_MAX_CHARS = 280;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function short(id: string): string {
	return id.slice(0, 12);
}

function claimLine(claim: ClaimRecord): string {
	// The text is built from typed fields, but check ids and paths come from the project's catalog.
	const text =
		claim.flagged !== undefined ? "[text withheld: instruction-shaped]" : clip(claim.text, CLAIM_TEXT_MAX_CHARS);
	return `claim ${short(claim.id)} ${claim.verdict}: ${text}`;
}

/** The latest open contradiction and the latest supersede of one check: what its delivery is about. */
function checkEdgeState(
	check: string,
	read: Pick<ClaimsLogRead, "edges">,
	statuses: ReadonlyMap<string, ClaimStatus>,
): { openContradiction: ClaimEdgeRecord | undefined; lastSupersede: ClaimEdgeRecord | undefined } {
	const ofCheck = read.edges.filter((edge) => edge.check === check);
	return {
		openContradiction: ofCheck
			.filter((edge) => edge.kind === "contradicts")
			.filter((edge) => statuses.get(edge.from) === "contested" && statuses.get(edge.to) === "contested")
			.at(-1),
		lastSupersede: ofCheck.filter((edge) => edge.kind === "supersedes").at(-1),
	};
}

/**
 * The state a delivery is offered for: the check's open contradiction and latest supersede. A rerun that adds a
 * standing claim leaves it unchanged, so the check is not offered again; a new contradiction or supersede changes it.
 */
export function claimsDeliveryState(
	check: string,
	read: Pick<ClaimsLogRead, "edges">,
	statuses: ReadonlyMap<string, ClaimStatus>,
): string {
	const { openContradiction, lastSupersede } = checkEdgeState(check, read, statuses);
	return `${check}\0${openContradiction?.id ?? ""}\0${lastSupersede?.id ?? ""}`;
}

/**
 * One check's delivery, or null when none of its claims is contested or superseded. Names the latest claim's status,
 * the open contradiction (both sides, never a merged verdict), and how many earlier verdicts were superseded and why.
 */
export function claimsDeliveryMessage(
	check: string,
	read: Pick<ClaimsLogRead, "records" | "edges">,
	statuses: ReadonlyMap<string, ClaimStatus> = claimStatuses(read.records, read.edges),
): string | null {
	const claims = read.records.filter((claim) => claim.keys.check === check);
	const latest = claims.at(-1);
	if (latest === undefined) return null;
	const byId = new Map(claims.map((claim) => [claim.id, claim]));
	const superseded = claims.filter((claim) => statuses.get(claim.id) === "superseded");
	const { openContradiction, lastSupersede } = checkEdgeState(check, read, statuses);
	if (openContradiction === undefined && superseded.length === 0) return null;
	const parts: string[] = [`[Claims] Check '${check}' has recorded claims this task touches.`];
	const later = openContradiction === undefined ? undefined : byId.get(openContradiction.from);
	const earlier = openContradiction === undefined ? undefined : byId.get(openContradiction.to);
	if (later !== undefined && earlier !== undefined) {
		parts.push(
			`Contested: ${claimLine(later)} It contradicts ${claimLine(earlier)} Opposite verdicts ${contradictionConditions(later, earlier)}.`,
		);
	} else {
		parts.push(`Latest: ${claimLine(latest)}`);
	}
	const replacing = lastSupersede === undefined ? undefined : byId.get(lastSupersede.from);
	const replaced = lastSupersede === undefined ? undefined : byId.get(lastSupersede.to);
	if (superseded.length > 0 && replacing !== undefined && replaced !== undefined)
		parts.push(
			`${superseded.length} earlier claim${superseded.length === 1 ? " was" : "s were"} superseded; the last by claim ${short(replacing.id)} (${supersedeConditions(replacing, replaced)}). Do not repeat a superseded verdict as current.`,
		);
	parts.push(
		"A claim states agreement within the check's declared tolerance under its recorded conditions, not truth; rerun the check to judge the current tree.",
	);
	return clip(parts.join(" "), CLAIMS_DELIVERY_MAX_CHARS);
}

/** Path-like argv entries: the analysis script a check runs counts as part of what the check judges. */
function pathLike(value: string): boolean {
	return value.includes("/") || /\.[A-Za-z0-9]+$/u.test(value);
}

function checkPaths(claim: ClaimRecord): string[] {
	return [...claim.keys.paths, ...claim.keys.command.filter(pathLike)];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Whether `token` appears in `text` as a whole token, not inside a longer word or path. */
function namesToken(text: string, token: string): boolean {
	return new RegExp(`(?<![\\w./-])${escapeRegExp(token)}(?![\\w/-]|\\.\\w)`, "u").test(text);
}

/** Checks whose id or claim paths the task text names. */
export function checksNamedByText(text: string, claims: ReadonlyArray<ClaimRecord>): string[] {
	const named = new Set<string>();
	for (const claim of claims) {
		if (named.has(claim.keys.check)) continue;
		if (namesToken(text, claim.keys.check) || checkPaths(claim).some((path) => namesToken(text, path)))
			named.add(claim.keys.check);
	}
	return [...named];
}

/** Checks whose claim paths include `path`, compared project-relative. */
export function checksTouchingPath(
	path: string,
	project: string,
	cwd: string,
	claims: ReadonlyArray<ClaimRecord>,
): string[] {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	const inside = relative(project, absolute);
	const candidates = new Set([path, absolute, ...(inside.startsWith("..") || isAbsolute(inside) ? [] : [inside])]);
	const touched = new Set<string>();
	for (const claim of claims) {
		const paths = checkPaths(claim).map((entry) =>
			isAbsolute(entry) ? entry : relative(project, resolve(project, entry)),
		);
		if (paths.some((entry) => candidates.has(entry))) touched.add(claim.keys.check);
	}
	return [...touched];
}

const PATH_TOOLS: ReadonlyArray<string> = [ToolNames.Read, ToolNames.Edit, ToolNames.Write];

/**
 * The two delivery registrations. The sync one reads the task at turn_start and path-taking tool calls; the awaited
 * one follows a `verify` call after claim capture has appended its claim and edges, so a contradiction this call
 * created reaches the model on the same result. They share one offered set.
 */
export function createClaimsDeliveryRegistrations(options: { cwd: () => string }): MiddlewareHookRegistration[] {
	let sessionKey: string | undefined;
	const offered = new Set<string>();
	let cache: { path: string; mtimeMs: number; size: number; read: ClaimsLogRead } | null = null;

	const load = (): ClaimsLogRead | null => {
		const project = claimsProjectRoot(options.cwd());
		const path = claimsLogPath(project);
		let stat: { mtimeMs: number; size: number };
		try {
			stat = statSync(path);
		} catch {
			// No log means no claims for this project; nothing to deliver.
			return null;
		}
		if (cache === null || cache.path !== path || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size)
			cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, read: readClaims(project) };
		return cache.read;
	};

	const deliver = (input: MiddlewareHookInput, pick: (read: ClaimsLogRead) => string[]): string[] => {
		// A new, resumed or forked session starts with nothing offered. The first turn of a fresh session carries no id
		// yet; the id it gains on the next hook is the same session, so only a change between two ids resets.
		if (input.sessionId !== undefined && sessionKey !== undefined && input.sessionId !== sessionKey) offered.clear();
		if (input.sessionId !== undefined) sessionKey = input.sessionId;
		const read = load();
		if (read === null || read.records.length === 0) return [];
		const statuses = claimStatuses(read.records, read.edges);
		const messages: string[] = [];
		for (const check of pick(read)) {
			if (messages.length >= CLAIMS_DELIVERY_MAX_CHECKS) break;
			const message = claimsDeliveryMessage(check, read, statuses);
			const state = claimsDeliveryState(check, read, statuses);
			if (message === null || offered.has(state)) continue;
			offered.add(state);
			messages.push(message);
		}
		return messages;
	};

	const asNotes = (messages: string[]): MiddlewareEffect[] =>
		messages.map((message) => ({ kind: "annotate_tool_result", severity: "info", message }));

	const stringArg = (input: MiddlewareHookInput, name: string): string | null => {
		const value = input.toolArgs?.[name];
		return typeof value === "string" && value.length > 0 ? value : null;
	};

	return [
		{
			id: CLAIMS_DELIVERY_REGISTRATION_ID,
			description: "offer contested or superseded claims of a check the task names or a file it touches",
			hooks: ["turn_start", "after_tool"],
			evidence: "typed:claims-log@task",
			evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
				if (input.hook === "turn_start") {
					const text = input.text ?? "";
					if (text.trim().length === 0) return [];
					return deliver(input, (read) => checksNamedByText(text, read.records)).map((message) => ({
						kind: "inject_reminder",
						severity: "info",
						audience: "model",
						message,
					}));
				}
				if (input.hook !== "after_tool" || input.toolName === undefined || !PATH_TOOLS.includes(input.toolName)) return [];
				const path = stringArg(input, "path");
				if (path === null) return [];
				const cwd = options.cwd();
				return asNotes(deliver(input, (read) => checksTouchingPath(path, claimsProjectRoot(cwd), cwd, read.records)));
			},
		},
		{
			id: CLAIMS_DELIVERY_VERIFY_REGISTRATION_ID,
			description: "offer contested or superseded claims of the check a verify call ran, after its claim is recorded",
			hooks: ["after_tool"],
			toolNames: [ToolNames.Verify],
			evidence: "typed:verify.check@tool-args",
			awaited: true,
			evaluate: () => [],
			async evaluateAsync(input: MiddlewareHookInput) {
				const check = stringArg(input, "check");
				if (input.toolName !== ToolNames.Verify || check === null) return [];
				return asNotes(deliver(input, (read) => (read.records.some((claim) => claim.keys.check === check) ? [check] : [])));
			},
		},
	];
}
