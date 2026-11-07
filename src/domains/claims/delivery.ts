import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimStatuses, contradictionConditions, supersedeConditions } from "./edges.js";
import { hypothesisStatuses, latestHypotheses } from "./hypotheses.js";
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
 * A verify call that ran the check a recorded hypothesis names also gets where that hypothesis now stands, once per
 * deciding test, so the agent reports the ledger's status instead of one it wrote itself.
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
function claimsDeliveryState(
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

/** Hypotheses one verify note names at most; a slate drafts a check for its top three. */
const HYPOTHESIS_NOTE_MAX = 3;

/**
 * Where each current hypothesis naming a check now stands, one line each, with the key of the test that decided it.
 * The slate keeps `proposed`, so the note says the ledger holds the status and the slate is not to be edited for it.
 */
function hypothesisNotes(check: string, read: ClaimsLogRead): Array<{ state: string; message: string }> {
	const states = hypothesisStatuses(read.hypotheses, read.hypothesisTests);
	const notes: Array<{ state: string; message: string }> = [];
	for (const hypothesis of latestHypotheses(read.hypotheses).values()) {
		if (hypothesis.criterion.check !== check) continue;
		const state = states.get(hypothesis.id);
		if (state?.decidedBy === undefined) continue;
		const test = state.decidedBy;
		const why =
			test.claim === undefined
				? `the check ran (${test.execution}) without a judged claim, so nothing supports or refutes it yet`
				: test.outcome === "supported"
					? `claim ${short(test.claim)} agrees within the declared tolerance`
					: `claim ${short(test.claim)} disagrees: the result did not satisfy the declared comparison`;
		notes.push({
			state: `hypothesis\0${hypothesis.id}\0${test.id}`,
			message: `Hypothesis ${hypothesis.hypothesis} of ${hypothesis.slate} (record ${short(hypothesis.id)}) is ${state.status} in the claims ledger: ${why}. The slate keeps status proposed; report this status from the ledger (clio-coder claims) and leave the slate as written.`,
		});
		if (notes.length >= HYPOTHESIS_NOTE_MAX) break;
	}
	return notes;
}

/**
 * The two delivery registrations. The sync one reads the task at turn_start and path-taking tool calls; the awaited
 * one follows a `verify` call after claim capture has appended its claim and edges, so a contradiction this call
 * created reaches the model on the same result. They share one offered set.
 */
/**
 * The offers already made, one `{session, state}` line each, beside the project's claims log. A headless
 * `run --session` continuation is a new process, so "once per session" has to outlive the process that offered.
 * Lines are small and appended with O_APPEND; a torn or foreign line is skipped, which at worst offers once more.
 */
function offersPath(project: string): string {
	return claimsLogPath(project).replace(/\.jsonl$/u, ".offers.jsonl");
}

function readOffers(path: string, session: string): Set<string> {
	const states = new Set<string>();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No offers file yet: nothing was offered in this project.
		return states;
	}
	for (const line of text.split("\n")) {
		try {
			const value = JSON.parse(line) as { session?: unknown; state?: unknown };
			if (value.session === session && typeof value.state === "string") states.add(value.state);
		} catch {
			// An empty or torn line names no offer.
		}
	}
	return states;
}

export function createClaimsDeliveryRegistrations(options: {
	cwd: () => string;
	now?: () => Date;
}): MiddlewareHookRegistration[] {
	const now = options.now ?? (() => new Date());
	let sessionKey: string | undefined;
	let loadedFor: string | undefined;
	const offered = new Set<string>();
	// Offers made on a fresh session's first turn, before it has an id; written once the id is known.
	let unrecorded: string[] = [];
	let cache: { path: string; mtimeMs: number; size: number; read: ClaimsLogRead } | null = null;

	const load = (project: string): ClaimsLogRead | null => {
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

	const record = (project: string, states: ReadonlyArray<string>): void => {
		if (sessionKey === undefined || states.length === 0) return;
		try {
			const path = offersPath(project);
			mkdirSync(dirname(path), { recursive: true });
			const at = now().toISOString();
			appendFileSync(path, states.map((state) => `${JSON.stringify({ session: sessionKey, state, at })}\n`).join(""), {
				mode: 0o600,
			});
		} catch {
			// An unwritable state dir only costs a repeat offer in a later process; the delivery itself still stands.
		}
	};

	const deliver = (input: MiddlewareHookInput, pick: (read: ClaimsLogRead) => string[]): string[] => {
		const project = claimsProjectRoot(options.cwd());
		// A new, resumed or forked session reads what was offered under its own id. The first turn of a fresh session
		// carries no id yet; the id it gains on the next hook is the same session, so only a change between ids resets.
		if (input.sessionId !== undefined && sessionKey !== undefined && input.sessionId !== sessionKey) {
			offered.clear();
			unrecorded = [];
		}
		if (input.sessionId !== undefined) sessionKey = input.sessionId;
		if (sessionKey !== undefined && loadedFor !== sessionKey) {
			loadedFor = sessionKey;
			for (const state of readOffers(offersPath(project), sessionKey)) offered.add(state);
			record(project, unrecorded);
			unrecorded = [];
		}
		const read = load(project);
		if (read === null || read.records.length === 0) return [];
		const statuses = claimStatuses(read.records, read.edges);
		const messages: string[] = [];
		const states: string[] = [];
		for (const check of pick(read)) {
			if (messages.length >= CLAIMS_DELIVERY_MAX_CHECKS) break;
			const message = claimsDeliveryMessage(check, read, statuses);
			const state = claimsDeliveryState(check, read, statuses);
			if (message === null || offered.has(state)) continue;
			offered.add(state);
			states.push(state);
			messages.push(message);
		}
		if (sessionKey === undefined) unrecorded.push(...states);
		else record(project, states);
		return messages;
	};

	// Runs after `deliver`, which has already settled the session key and loaded this session's earlier offers.
	const deliverHypotheses = (check: string): string[] => {
		const project = claimsProjectRoot(options.cwd());
		const read = load(project);
		if (read === null || read.hypotheses.length === 0) return [];
		const fresh = hypothesisNotes(check, read).filter((note) => !offered.has(note.state));
		for (const note of fresh) offered.add(note.state);
		const states = fresh.map((note) => note.state);
		if (sessionKey === undefined) unrecorded.push(...states);
		else record(project, states);
		return fresh.map((note) => note.message);
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
				const messages = deliver(input, (read) =>
					read.records.some((claim) => claim.keys.check === check) ? [check] : [],
				);
				return asNotes([...messages, ...deliverHypotheses(check)]);
			},
		},
	];
}
