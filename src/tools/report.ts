/**
 * The agent's `report` tool (R-12). The agent writes what happened; the host fills the environment and what Clio
 * observed, keeps the offer budget, scrubs the text and saves the draft. Nothing here sends: the operator does, from
 * `/report send` or `clio-coder report send` in a terminal.
 */

import {
	composeReportDraft,
	type IdentitySettings,
	isFirstSession,
	type LocalIdentity,
	localIdentity,
	mayOffer,
	observeSession,
	type ReportArea,
	type ReportDraft,
	type ReportKind,
	type ReportOffersSetting,
	type ReportSessionFacts,
	readOfferLedger,
	readOutbox,
	readReportDraft,
	recordAnswer,
	recordOfferShown,
	rememberIdentity,
	reportFingerprint,
	saveReportDraft,
	scrubText,
	stripHiddenText,
	updateOutbox,
} from "../domains/report/index.js";
import { isOneOf, REPORT_AREAS, REPORT_KINDS } from "../domains/report/vocabulary.js";
import type { AskUserHandler, AskUserQuestion } from "./ask-user.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { reportToolSurface } from "./report-surface.js";

export const REPORT_OFFER_REFUSED = "Do not offer or mention reporting again in this session.";
/** No send command reaches the model: the agent drafts, the operator sends (R2b-report-04). */
const REPORT_NOT_YOURS = "You cannot send it; do not run gh or clio-coder for this.";
/** Unsent agent drafts an install keeps before the tool stops writing new ones. */
export const AGENT_DRAFT_LIMIT = 3;

const OFFER_QUESTION =
	"This looks like a problem in Clio Coder itself. Should I draft a report? You read every word before anything is sent.";
const OFFER_OPTIONS = { draft: "Draft it", later: "Not now", never: "Don't ask again" } as const;

export interface ReportToolSession {
	id: string;
	cwd?: string;
	facts?: ReportSessionFacts;
}

export interface ReportToolDeps {
	stateDir: string;
	version: string;
	surface: "tui" | "headless" | "acp";
	session: () => ReportToolSession | null;
	offers: () => ReportOffersSetting;
	/** `report.offers: off`, written when the operator answers "Don't ask again". */
	writeOffersOff: () => void;
	/** Present on a surface with an operator to ask. */
	askUser?: AskUserHandler;
	/** The operator is there to answer now: attended, and not away at yolo. */
	attended: () => boolean;
	/** Tells the operator a draft was saved, without opening anything; null when no surface can show a notice. */
	openReview: () => ((draftId: string) => void) | null;
	identitySettings?: () => IdentitySettings;
	identity?: (cwd: string) => Promise<LocalIdentity>;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

interface ReportArgs {
	action: "offer" | "draft";
	kind: ReportKind;
	title: string;
	happened: string;
	operatorWords: string;
	expected: string;
	reproduce: string;
	notKnown: string[];
	area: ReportArea | null;
}

function text(value: unknown): string {
	return typeof value === "string" ? stripHiddenText(value).trim() : "";
}

function parseArgs(args: Record<string, unknown>): ReportArgs | string {
	const action = args.action;
	if (action !== "offer" && action !== "draft") return 'action must be "offer" or "draft"';
	if (!isOneOf(REPORT_KINDS, args.kind)) return `kind must be one of ${REPORT_KINDS.join(", ")}`;
	const title = text(args.title);
	const happened = text(args.happened);
	if (title.length === 0) return "title is required";
	if (action === "draft" && happened.length === 0) return "happened is required";
	if (!Array.isArray(args.not_known)) return "not_known is required; pass [] when everything was verified";
	return {
		action,
		kind: args.kind,
		title,
		happened,
		operatorWords: text(args.operator_words),
		expected: text(args.expected),
		reproduce: text(args.reproduce),
		notKnown: args.not_known.map(text).filter((line) => line.length > 0),
		area: isOneOf(REPORT_AREAS, args.area) ? args.area : null,
	};
}

function ok(output: string, details: Record<string, unknown> = {}): ToolResult {
	return { kind: "ok", output, details };
}

/** Unsent drafts the agent wrote, newest first. */
function unsentAgentDrafts(stateDir: string): ReportDraft[] {
	const drafts: ReportDraft[] = [];
	for (const [id, entry] of Object.entries(readOutbox(stateDir))) {
		if (entry.state !== "draft") continue;
		const draft = readReportDraft(stateDir, id);
		if (draft?.origin === "agent") drafts.push(draft);
	}
	return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createReportTool(deps: ReportToolDeps): ToolSpec {
	const now = deps.now ?? (() => new Date());
	/** The draft this process wrote for each session: one a session. */
	const sessionDrafts = new Map<string, string>();

	const fingerprintFor = (sessionId: string | null, title: string): string => {
		const version = deps.version;
		if (sessionId !== null) {
			const ended = observeSession(deps.stateDir, sessionId).find((observation) => observation.code === "turn-ended");
			if (ended?.code === "turn-ended" && ended.values.cause)
				return reportFingerprint({
					trigger: ended.values.cause === "internal" ? "internal" : "repeated",
					cause: ended.values.cause,
					version,
				});
		}
		return reportFingerprint({ trigger: "agent", cause: title.toLowerCase().replace(/\s+/gu, " "), version });
	};

	const offer = async (args: ReportArgs, options: Parameters<ToolSpec["run"]>[1]): Promise<ToolResult> => {
		const session = deps.session();
		const sessionId = session?.id ?? null;
		const fingerprint = fingerprintFor(sessionId, args.title);
		const at = now();
		const allowed =
			deps.askUser !== undefined &&
			sessionId !== null &&
			mayOffer({ fingerprint }, at.getTime(), {
				id: sessionId,
				offers: deps.offers(),
				ledger: readOfferLedger(deps.stateDir),
				// The agent asks between its own steps, so the turn is its moment.
				turnRunning: false,
				attended: deps.attended(),
				firstSession: isFirstSession(),
			});
		if (!allowed || deps.askUser === undefined || sessionId === null) return ok(REPORT_OFFER_REFUSED, { offered: false });
		recordOfferShown(deps.stateDir, sessionId, at);
		const question: AskUserQuestion = {
			question: OFFER_QUESTION,
			header: "Report",
			options: [{ label: OFFER_OPTIONS.draft }, { label: OFFER_OPTIONS.later }, { label: OFFER_OPTIONS.never }],
			fixedChoices: true,
		};
		const result = await deps.askUser([question], options);
		const chosen = result.cancelled ? undefined : result.answers[0]?.options?.[0];
		if (chosen === OFFER_OPTIONS.draft)
			return ok('The operator wants a report. Call report with action "draft" now.', { offered: true, answer: "draft" });
		if (chosen === OFFER_OPTIONS.never) {
			recordAnswer(deps.stateDir, fingerprint, "never", { now: at, writeOffersOff: deps.writeOffersOff });
			return ok(REPORT_OFFER_REFUSED, { offered: true, answer: "never" });
		}
		recordAnswer(deps.stateDir, fingerprint, "declined", { now: at });
		return ok(REPORT_OFFER_REFUSED, { offered: true, answer: "declined" });
	};

	const draft = async (args: ReportArgs): Promise<ToolResult> => {
		const session = deps.session();
		const sessionId = session?.id ?? null;
		const existing = sessionId !== null ? sessionDrafts.get(sessionId) : undefined;
		const unsent = unsentAgentDrafts(deps.stateDir);
		const kept = existing ?? (unsent.length >= AGENT_DRAFT_LIMIT ? unsent[0]?.id : undefined);
		if (kept !== undefined)
			return ok(
				`A draft already waits for the operator: ${kept}. Do not write another; the operator reviews and sends it.`,
				{ draftId: kept, created: false },
			);

		const cwd = session?.cwd ?? process.cwd();
		const identity = await (
			deps.identity ??
			((dir: string) => localIdentity(dir, deps.identitySettings?.() ?? {}, { env: deps.env ?? process.env }))
		)(cwd).catch((): LocalIdentity => ({ packageRoot: null, paths: [], remotes: [], names: [] }));
		const scrub = (value: string): string => (value.length === 0 ? value : scrubText(value, identity).text);
		const composed = composeReportDraft({
			kind: args.kind,
			surface: deps.surface === "acp" ? "acp" : deps.surface,
			title: scrub(args.title),
			happened: scrub(args.happened),
			session:
				sessionId === null
					? null
					: {
							id: sessionId,
							observations: observeSession(deps.stateDir, sessionId),
							...(session?.facts ? { facts: session.facts } : {}),
						},
			now: now(),
		});
		const saved: ReportDraft = rememberIdentity(
			{
				...composed,
				origin: "agent",
				trigger: "agent",
				fingerprint: null,
				area: args.area,
				sections: {
					...composed.sections,
					operatorWords: scrub(args.operatorWords),
					expected: scrub(args.expected),
					reproduce: scrub(args.reproduce),
					notKnown: args.notKnown.map(scrub),
				},
			},
			identity,
		);
		saveReportDraft(deps.stateDir, saved);
		updateOutbox(deps.stateDir, saved.id, { kind: saved.kind, title: saved.title, state: "draft" });
		if (sessionId !== null) sessionDrafts.set(sessionId, saved.id);
		const notice = deps.openReview();
		notice?.(saved.id);
		return ok(`Saved as ${saved.id} for the operator to review. ${REPORT_NOT_YOURS}`, {
			draftId: saved.id,
			created: true,
			notified: notice !== null,
		});
	};

	return {
		...reportToolSurface,
		async run(raw, options): Promise<ToolResult> {
			const args = parseArgs((raw ?? {}) as Record<string, unknown>);
			if (typeof args === "string") return { kind: "error", message: `report: ${args}` };
			try {
				return args.action === "offer" ? await offer(args, options) : await draft(args);
			} catch (error) {
				return { kind: "error", message: `report: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}
