import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalCheckout, checkoutHead } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { ToolNames } from "../../core/tool-names.js";
import { UNTRUSTED_CONTENT_BANNER } from "../../core/untrusted-content.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimStatuses, contradictionConditions, supersedeConditions } from "./edges.js";
import { hypothesisStatuses, latestHypotheses } from "./hypotheses.js";
import { type ClaimsLogRead, claimsLogPath, readClaims } from "./store.js";
import type { ClaimDisputeRecord, ClaimEdgeRecord, ClaimRecord, ClaimStatus } from "./types.js";

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

/** Per check message cap (the untrusted banner included) and per hook check cap: at most about 2.6 KB per hook point. */
export const CLAIMS_DELIVERY_MAX_CHARS = 1300;
export const CLAIMS_DELIVERY_MAX_CHECKS = 2;
const CLAIM_TEXT_MAX_CHARS = 280;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function short(id: string): string {
	return id.slice(0, 12);
}

/**
 * Why a delivered claim no longer describes the checkout the session is in (#406): it was recorded at a commit HEAD
 * has moved past. Null when it was recorded at HEAD, or when either commit is unknown.
 */
function staleNote(claim: ClaimRecord, head: string | null): string | null {
	const commit = claim.conditions.commit;
	if (commit === null || head === null || commit === head) return null;
	return `[stale: recorded at commit ${short(commit)}; HEAD is now ${short(head)}]`;
}

function claimLine(claim: ClaimRecord, head: string | null = null): string {
	// The text is built from typed fields, but check ids and paths come from the project's catalog.
	const text =
		claim.flagged !== undefined ? "[text withheld: instruction-shaped]" : clip(claim.text, CLAIM_TEXT_MAX_CHARS);
	const stale = staleNote(claim, head);
	return `claim ${short(claim.id)} ${claim.verdict}${stale !== null ? ` ${stale}` : ""}: ${text}`;
}

/** The latest open contradiction and the latest supersede of one check: what its delivery is about. */
function checkEdgeState(
	check: string,
	read: Pick<ClaimsLogRead, "edges">,
	statuses: ReadonlyMap<string, ClaimStatus>,
): { openContradiction: ClaimEdgeRecord | undefined; lastSupersede: ClaimEdgeRecord | undefined } {
	const ofCheck = read.edges.filter((edge) => edge.check === check);
	return {
		// Open while the later side is contested; the earlier side is contested too, or retired when the later one was a
		// failure that overturned a pass.
		openContradiction: ofCheck
			.filter((edge) => edge.kind === "contradicts")
			.filter(
				(edge) =>
					statuses.get(edge.from) === "contested" &&
					(statuses.get(edge.to) === "contested" || statuses.get(edge.to) === "retired"),
			)
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
	read: Pick<ClaimsLogRead, "records" | "edges">,
	statuses: ReadonlyMap<string, ClaimStatus>,
	head: string | null = null,
): string {
	const { openContradiction, lastSupersede } = checkEdgeState(check, read, statuses);
	// Offered again once when the check's latest claim turns stale, so a session whose HEAD moved learns it.
	const latest = read.records.filter((claim) => claim.keys.check === check).at(-1);
	const stale = latest !== undefined && staleNote(latest, head) !== null ? `stale:${head}` : "";
	return `${check}\0${openContradiction?.id ?? ""}\0${lastSupersede?.id ?? ""}\0${stale}`;
}

/**
 * One check's delivery, or null when none of its claims is contested or superseded. Names the latest claim's status,
 * the open contradiction (both sides, never a merged verdict), and how many earlier verdicts were superseded and why.
 */
export function claimsDeliveryMessage(
	check: string,
	read: Pick<ClaimsLogRead, "records" | "edges">,
	statuses: ReadonlyMap<string, ClaimStatus> = claimStatuses(read.records, read.edges),
	head: string | null = null,
): string | null {
	const claims = read.records.filter((claim) => claim.keys.check === check);
	const latest = claims.at(-1);
	if (latest === undefined) return null;
	const byId = new Map(claims.map((claim) => [claim.id, claim]));
	const superseded = claims.filter((claim) => statuses.get(claim.id) === "superseded");
	const { openContradiction, lastSupersede } = checkEdgeState(check, read, statuses);
	if (openContradiction === undefined && superseded.length === 0) return null;
	// Claim text is built from typed fields, but check ids and paths come from the project's catalog, which a cloned
	// repository may ship; the banner marks what follows as data before any of it.
	const parts: string[] = [`[Claims] Check '${check}' has recorded claims this task touches.`, UNTRUSTED_CONTENT_BANNER];
	const later = openContradiction === undefined ? undefined : byId.get(openContradiction.from);
	const earlier = openContradiction === undefined ? undefined : byId.get(openContradiction.to);
	if (later !== undefined && earlier !== undefined) {
		const retired = statuses.get(earlier.id) === "retired" ? " (retired: this failure overturned it)" : "";
		parts.push(
			`Contested: ${claimLine(later, head)} It contradicts ${claimLine(earlier, head)}${retired} Opposite verdicts ${contradictionConditions(later, earlier)}.`,
		);
	} else {
		parts.push(`Latest: ${claimLine(latest, head)}`);
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

/** Disputes one hook point offers at most, beside the checks. */
const DISPUTE_DELIVERY_MAX = 2;

function disputeSide(post: ClaimDisputeRecord["target"], flagged: boolean): string {
	const where = post.path === undefined ? "" : ` ${post.path}${post.line === undefined ? "" : `:${post.line}`}`;
	const text = flagged ? "[text withheld: instruction-shaped]" : post.text;
	return `${post.kind} ${post.entry} by ${post.agentId} (run ${post.runId})${where}: ${text}`;
}

/**
 * A worker disagreement kept past its dispatch (#406): both posts as their authors wrote them, no merged verdict, and
 * the reminder that neither is evidence.
 */
function disputeDeliveryMessage(dispute: ClaimDisputeRecord): string {
	const flagged = dispute.flagged !== undefined;
	return clip(
		[
			`[Claims] Workers disagreed on a ledger entry this task touches (dispatch ledger ${dispute.ledger}, ${dispute.at}).`,
			UNTRUSTED_CONTENT_BANNER,
			`Disputed ${disputeSide(dispute.target, flagged)}`,
			`Failing review ${disputeSide(dispute.review, flagged)}`,
			"Both sides are model-authored and inferred, not verified; no verdict was merged. Check the cited code before relying on either.",
		].join(" "),
		CLAIMS_DELIVERY_MAX_CHARS,
	);
}

function disputePaths(dispute: ClaimDisputeRecord): string[] {
	return [dispute.target.path, dispute.review.path].filter((path): path is string => path !== undefined);
}

/** Disputes whose posts cite a path the text names as a whole token. */
function disputesNamedByText(text: string, disputes: ReadonlyArray<ClaimDisputeRecord>): ClaimDisputeRecord[] {
	return disputes.filter((dispute) => disputePaths(dispute).some((path) => namesToken(text, path)));
}

function disputesTouchingPath(
	path: string,
	checkout: string,
	cwd: string,
	disputes: ReadonlyArray<ClaimDisputeRecord>,
): ClaimDisputeRecord[] {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	return disputes.filter((dispute) =>
		disputePaths(dispute).some((entry) => resolve(checkout, entry) === absolute || entry === path),
	);
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
			// The hypothesis id and slate path are model-authored, so the note opens with the untrusted banner.
			message: `${UNTRUSTED_CONTENT_BANNER} Hypothesis ${hypothesis.hypothesis} of ${hypothesis.slate} (record ${short(hypothesis.id)}) is ${state.status} in the claims ledger: ${why}. The slate keeps status proposed; report this status from the ledger (clio-coder claims) and leave the slate as written.`,
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

/** Offers files past this size are trimmed when a session first loads them. */
export const CLAIMS_OFFERS_MAX_BYTES = 256 * 1024;
/** Offers older than this are dropped by the trim: a session idle this long is offered again, once. */
export const CLAIMS_OFFERS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Keep the offers file bounded (#406): past `CLAIMS_OFFERS_MAX_BYTES`, rewrite it with only the offers made within
 * the retention window. Offers only deduplicate within a session, so dropping an old one costs at most one repeat
 * offer to a session resumed after the window. The rewrite is atomic; an offer appended by another process while it
 * runs can be lost, with the same cost. Returns whether the file was rewritten.
 */
export function trimClaimsOffers(project: string, now: Date = new Date()): boolean {
	const path = offersPath(project);
	let text: string;
	try {
		if (statSync(path).size <= CLAIMS_OFFERS_MAX_BYTES) return false;
		text = readFileSync(path, "utf8");
	} catch {
		// No offers file: nothing to trim.
		return false;
	}
	const cutoff = now.getTime() - CLAIMS_OFFERS_RETENTION_MS;
	const kept = text.split("\n").filter((line) => {
		try {
			const value = JSON.parse(line) as { at?: unknown };
			return typeof value.at === "string" && Date.parse(value.at) >= cutoff;
		} catch {
			return false;
		}
	});
	try {
		safeResourceWrite(path, kept.length === 0 ? "" : `${kept.join("\n")}\n`, { mode: 0o600 });
		return true;
	} catch {
		// An unwritable state dir leaves the file as it was; it only costs read time.
		return false;
	}
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

	const deliver = (
		input: MiddlewareHookInput,
		pick: (read: ClaimsLogRead) => string[],
		pickDisputes: (read: ClaimsLogRead) => ClaimDisputeRecord[] = () => [],
	): string[] => {
		const checkout = canonicalCheckout(options.cwd());
		const project = checkout.project;
		// A new, resumed or forked session reads what was offered under its own id. The first turn of a fresh session
		// carries no id yet; the id it gains on the next hook is the same session, so only a change between ids resets.
		if (input.sessionId !== undefined && sessionKey !== undefined && input.sessionId !== sessionKey) {
			offered.clear();
			unrecorded = [];
		}
		if (input.sessionId !== undefined) sessionKey = input.sessionId;
		if (sessionKey !== undefined && loadedFor !== sessionKey) {
			loadedFor = sessionKey;
			trimClaimsOffers(project, now());
			for (const state of readOffers(offersPath(project), sessionKey)) offered.add(state);
			record(project, unrecorded);
			unrecorded = [];
		}
		const read = load(project);
		if (read === null || (read.records.length === 0 && read.disputes.length === 0)) return [];
		const statuses = claimStatuses(read.records, read.edges);
		const head = read.records.length === 0 ? null : checkoutHead(checkout.checkout);
		const messages: string[] = [];
		const states: string[] = [];
		for (const check of pick(read)) {
			if (messages.length >= CLAIMS_DELIVERY_MAX_CHECKS) break;
			const message = claimsDeliveryMessage(check, read, statuses, head);
			const state = claimsDeliveryState(check, read, statuses, head);
			if (message === null || offered.has(state)) continue;
			offered.add(state);
			states.push(state);
			messages.push(message);
		}
		let disputes = 0;
		for (const dispute of read.disputes.length === 0 ? [] : pickDisputes(read)) {
			if (disputes >= DISPUTE_DELIVERY_MAX) break;
			const state = `dispute\0${dispute.id}`;
			if (offered.has(state)) continue;
			offered.add(state);
			states.push(state);
			messages.push(disputeDeliveryMessage(dispute));
			disputes += 1;
		}
		if (sessionKey === undefined) unrecorded.push(...states);
		else record(project, states);
		return messages;
	};

	// Runs after `deliver`, which has already settled the session key and loaded this session's earlier offers.
	const deliverHypotheses = (check: string): string[] => {
		const project = canonicalCheckout(options.cwd()).project;
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
					return deliver(
						input,
						(read) => checksNamedByText(text, read.records),
						(read) => disputesNamedByText(text, read.disputes),
					).map((message) => ({
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
				// Claim paths are relative to the checkout the check ran in, which is this one for a session in it.
				const checkout = canonicalCheckout(cwd).checkout;
				return asNotes(
					deliver(
						input,
						(read) => checksTouchingPath(path, checkout, cwd, read.records),
						(read) => disputesTouchingPath(path, checkout, cwd, read.disputes),
					),
				);
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
