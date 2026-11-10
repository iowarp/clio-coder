import { isFixedPoint, type RenderedReport, renderReport } from "./body.js";
import { deleteReportBundle } from "./bundle.js";
import {
	applyVerdict,
	findRelated,
	type RelatedDeps,
	type RelatedIssue,
	type RelatedVerdict,
	renderComment,
} from "./dedup.js";
import { newReportId, type ReportDraft, validateDraft } from "./draft.js";
import { type ReportEnvironment, type ReportSessionFacts, reportEnvironment } from "./environment.js";
import { reportFingerprint } from "./fingerprint.js";
import type { ReportObservation } from "./observe.js";
import { outboxEntry, readOutbox, recentSends, updateOutbox } from "./outbox.js";
import type { LocalIdentity, MaskKind, ReportMask } from "./scrub.js";
import { deleteReportDraft, listReportDrafts, readReportDraft, saveReportDraft } from "./store.js";
import { type ReportTransport, routeFor, type SendDeps, type SendResult, sendReport } from "./transport.js";
import { REPORT_HEADINGS, REPORT_REPOSITORY, type ReportKind, type ReportSurface } from "./vocabulary.js";

/**
 * How a plan names the transport. A dry run does not ask GitHub who is signed in, so its `gh` has no login yet.
 * A detected `ReportTransport` is assignable to this.
 */
export type ReportPlanTransport = { kind: "gh"; login: string | null } | { kind: "browser" } | { kind: "file" };

/**
 * Everything a surface shows before it sends: the CLI, the TUI overlay and the GUI all render this, and none of them
 * decides what is sent. `rendered` is the exact text the transport posts.
 */
export interface ReportPlan {
	/** "posted as @login", "opens your browser" or "writes a file"; `planHeadline` makes the first line from it. */
	postedAs: string;
	destination: string;
	rendered: RenderedReport;
	masks: ReportMask[];
	/** "Masked by Clio: 1 host name, 2 paths. No secrets found." */
	maskSummary: string;
	/** The network actions sending takes, in order, as sentences. */
	actions: string[];
	/** The issue never carries a bundle: a bundle stays on this machine until R-18 uploads one. */
	bundle: null;
	consent: "none";
	credit: boolean;
	/** Gate failures that keep the report from being sent; empty when it may go. */
	gates: string[];
	rateWarning: string | null;
}

export interface PlanOptions {
	identity: LocalIdentity;
	transport: ReportPlanTransport;
	/** Reads the outbox for the soft rate warning when given. */
	stateDir?: string;
}

const DESTINATION = `github.com/${REPORT_REPOSITORY}`;

function postedAs(transport: ReportPlanTransport): string {
	switch (transport.kind) {
		case "gh":
			return transport.login !== null ? `posted as @${transport.login}` : "posted from your gh account";
		case "browser":
			return "opens your browser";
		case "file":
			return "writes a file";
	}
}

/** The plan's first line, with the separator each surface uses: "Public, posted as @login to github.com/...". */
export function planHeadline(plan: Pick<ReportPlan, "postedAs" | "destination">, separator = ", "): string {
	const joint = plan.postedAs.startsWith("posted") ? "to" : plan.postedAs === "writes a file" ? "to post at" : "at";
	return `Public${separator}${plan.postedAs} ${joint} ${plan.destination}`;
}

function planActions(kind: ReportKind, transport: ReportPlanTransport): string[] {
	const where = kind === "question" ? "a public discussion in Help" : "a public issue";
	if (transport.kind === "gh") {
		const who = transport.login !== null ? `@${transport.login}` : "your gh account";
		return [
			`search ${REPORT_REPOSITORY} for an existing report of the same problem`,
			`post the text you reviewed as ${where} from ${who}`,
		];
	}
	const file = "write the text you reviewed to a file in Clio's state directory";
	if (transport.kind === "browser")
		return [file, `open ${DESTINATION} in your browser with that text filled in; nothing is posted until you submit it`];
	return [file, `print the link to post it at ${DESTINATION} yourself; nothing goes over the network`];
}

const MASK_NOUNS: Readonly<Record<MaskKind, [string, string]>> = {
	secret: ["secret", "secrets"],
	path: ["path", "paths"],
	url: ["URL", "URLs"],
	email: ["email address", "email addresses"],
	ip: ["IP address", "IP addresses"],
	user: ["user name", "user names"],
	host: ["host name", "host names"],
	project: ["project name", "project names"],
	branch: ["branch name", "branch names"],
	remote: ["repository name", "repository names"],
	target: ["target name", "target names"],
};

export function maskNoun(kind: MaskKind, count: number): string {
	const [one, many] = MASK_NOUNS[kind];
	return `${count} ${count === 1 ? one : many}`;
}

/** One sentence over the masks by kind; values never appear in a mask, so none appear here. */
export function maskSummary(masks: ReadonlyArray<ReportMask>): string {
	const totals = new Map<MaskKind, number>();
	for (const mask of masks) totals.set(mask.kind, (totals.get(mask.kind) ?? 0) + mask.count);
	const secrets = totals.get("secret") ?? 0;
	totals.delete("secret");
	const parts = [...totals.entries()].map(([kind, count]) => maskNoun(kind, count));
	const head = parts.length > 0 ? `Masked by Clio: ${parts.join(", ")}.` : "Nothing needed masking.";
	return `${head} ${secrets > 0 ? `${maskNoun("secret", secrets)} redacted; those stay masked.` : "No secrets found."}`;
}

export function planReport(draft: ReportDraft, options: PlanOptions): ReportPlan {
	const rendered = renderReport(draft, options.identity);
	const gates = validateDraft(draft, rendered);
	if (!isFixedPoint(rendered, options.identity, draft.unmasked))
		gates.push("Scrubbing the report again would change it; edit the text so every masked value is gone.");
	let rateWarning: string | null = null;
	if (options.stateDir !== undefined) {
		try {
			rateWarning = recentSends(options.stateDir).warning;
		} catch {
			// A damaged outbox gives no warning here; sending reports the damage.
		}
	}
	return {
		postedAs: postedAs(options.transport),
		destination: DESTINATION,
		rendered,
		masks: rendered.masks,
		maskSummary: maskSummary(rendered.masks),
		actions: planActions(draft.kind, options.transport),
		bundle: null,
		consent: "none",
		credit: draft.credit === true,
		gates,
		rateWarning,
	};
}

export interface ComposeReportInput {
	kind: ReportKind;
	surface: ReportSurface;
	title?: string;
	happened?: string;
	/** The session the report is about; its observations fill "What Clio observed". */
	session?: { id: string; observations: ReadonlyArray<ReportObservation>; facts?: ReportSessionFacts } | null;
	environment?: ReportEnvironment;
	now?: Date;
}

/**
 * A new operator draft. With a session, its last turn's cause is recorded; an `internal` cause makes the report
 * machine-triggered, with a fingerprint the dedup step can match exactly.
 */
export function composeReportDraft(input: ComposeReportInput): ReportDraft {
	const now = input.now ?? new Date();
	const environment = input.environment ?? reportEnvironment(input.surface, input.session?.facts);
	const observed = [...(input.session?.observations ?? [])];
	const ended = observed.find((observation) => observation.code === "turn-ended");
	const cause = ended?.code === "turn-ended" ? ended.values.cause : null;
	const trigger = cause === "internal" ? "internal" : "operator";
	return {
		id: newReportId(now.getTime()),
		createdAt: now.toISOString(),
		kind: input.kind,
		origin: "operator",
		title: input.title?.trim() ?? "",
		sections: { happened: input.happened?.trim() ?? "", operatorWords: "", expected: "", reproduce: "", notKnown: [] },
		observed,
		environment,
		includeModel: true,
		area: null,
		trigger,
		cause,
		fingerprint: trigger === "internal" ? reportFingerprint({ trigger, cause, version: environment.clioCoder }) : null,
		links: [],
		sessionId: input.session?.id ?? null,
		unmasked: [],
	};
}

const TEMPLATE_GUIDE = [
	"<!--",
	"Write what happened below. Lines inside comments like this one are removed.",
	"After you save, Clio masks paths, host names and secrets again and shows the exact text before anything is sent.",
	"-->",
];

/** The draft as an editable document: a `Title:` line, then the sections a person writes, under their headings. */
export function reportEditTemplate(draft: ReportDraft): string {
	const block = (heading: string, text: string) => `### ${heading}\n\n${text.trim()}\n`;
	return [
		`Title: ${draft.title.trim()}`,
		"",
		...TEMPLATE_GUIDE,
		"",
		block(REPORT_HEADINGS.happened, draft.sections.happened),
		block(REPORT_HEADINGS.expected, draft.sections.expected),
		block(REPORT_HEADINGS.reproduce, draft.sections.reproduce),
	].join("\n");
}

const TEMPLATE_SECTIONS: ReadonlyArray<[string, "happened" | "expected" | "reproduce"]> = [
	[REPORT_HEADINGS.happened.toLowerCase(), "happened"],
	[REPORT_HEADINGS.expected.toLowerCase(), "expected"],
	[REPORT_HEADINGS.reproduce.toLowerCase(), "reproduce"],
];

/** The draft with an edited template read back; text before the first heading other than the title is kept in "What happened". */
export function applyReportEdit(draft: ReportDraft, text: string): ReportDraft {
	const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").split(/\r?\n/u);
	let title = draft.title;
	let titleRead = false;
	const found: Record<"happened" | "expected" | "reproduce", string[]> = { happened: [], expected: [], reproduce: [] };
	let current: keyof typeof found = "happened";
	for (const line of lines) {
		const titleMatch = titleRead ? null : /^title:\s*(.*)$/iu.exec(line);
		if (titleMatch !== null) {
			title = (titleMatch[1] ?? "").trim();
			titleRead = true;
			continue;
		}
		const heading = /^#{1,6}\s+(.*?)\s*$/u.exec(line);
		const section = heading ? TEMPLATE_SECTIONS.find(([name]) => name === heading[1]?.toLowerCase()) : undefined;
		if (section !== undefined) {
			current = section[1];
			continue;
		}
		found[current].push(line);
	}
	const join = (parts: string[]) => parts.join("\n").trim();
	return {
		...draft,
		title,
		sections: {
			...draft.sections,
			happened: join(found.happened),
			expected: join(found.expected),
			reproduce: join(found.reproduce),
		},
	};
}

/** What the reporter may do when the search found a match; null when the verdict needs no choice. */
export type DuplicateChoice = "comment" | "new" | "stop";

export function duplicateOptions(verdict: RelatedVerdict): Array<{ value: DuplicateChoice; label: string }> | null {
	if (verdict.kind === "comment")
		return [
			{ value: "comment", label: `Add mine to #${verdict.issue.number} (a +1 and my details as a comment)` },
			{ value: "new", label: `File a new issue that links #${verdict.issue.number}` },
			{ value: "stop", label: "Cancel" },
		];
	if (verdict.kind === "upgrade")
		return [
			{ value: "stop", label: `Upgrade first: ${verdict.latest} is out and #${verdict.issue.number} was closed` },
			{ value: "new", label: `Report anyway, linking #${verdict.issue.number}` },
		];
	return null;
}

/** One line per match, for the duplicates step. */
export function relatedLine(issue: RelatedIssue): string {
	const fixed = issue.fixedIn !== null ? ` · fixed in ${issue.fixedIn}` : "";
	return `#${issue.number}  ${issue.state}  ${issue.title}${fixed}`;
}

export interface ReportFlowDeps extends SendDeps {
	identity: LocalIdentity;
	transport: ReportTransport;
	related?: RelatedDeps;
	/** Asked only when the search found an open match or a fix in a newer version. */
	chooseDuplicate: (
		verdict: RelatedVerdict,
		options: Array<{ value: DuplicateChoice; label: string }>,
	) => Promise<DuplicateChoice>;
}

export type ReportFlowOutcome =
	| { kind: "sent"; result: SendResult; draft: ReportDraft; rendered: RenderedReport; verdict: RelatedVerdict }
	| { kind: "stopped"; draft: ReportDraft; verdict: RelatedVerdict };

/**
 * The send step every surface runs after the reporter pressed send: search, ask about a match, then file, add to the
 * match or open the browser. A regression or a linked new issue re-renders the draft so its title and block say so.
 */
export async function runReportSend(
	draft: ReportDraft,
	rendered: RenderedReport,
	deps: ReportFlowDeps,
): Promise<ReportFlowOutcome> {
	const related = await findRelated(draft, rendered, deps.transport, {
		...deps.related,
		...(deps.run !== undefined ? { run: deps.run } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
	});
	const verdict = related.verdict;
	const options = duplicateOptions(verdict);
	const choice = options === null ? null : await deps.chooseDuplicate(verdict, options);
	if (choice === "stop") {
		saveReportDraft(deps.stateDir, draft);
		updateOutbox(deps.stateDir, draft.id, { kind: draft.kind, title: rendered.title, state: "draft" });
		return { kind: "stopped", draft, verdict };
	}
	let final = applyVerdict(draft, verdict);
	if (choice === "new" && "issue" in verdict && !final.links.includes(verdict.issue.number))
		final = { ...final, links: [...final.links, verdict.issue.number] };
	const finalRendered = final === draft ? rendered : renderReport(final, deps.identity);
	saveReportDraft(deps.stateDir, final);
	const route = routeFor(final.kind);
	const action =
		choice === "comment" && verdict.kind === "comment"
			? { kind: "comment" as const, number: verdict.issue.number, body: renderComment(finalRendered, final) }
			: { kind: "create" as const };
	const result = await sendReport(finalRendered, route, deps.transport, action, deps);
	const facts = {
		kind: final.kind,
		title: finalRendered.title,
		consent: "none",
		credit: final.credit === true,
	};
	if (result.status === "commented" || result.status === "reacted")
		updateOutbox(deps.stateDir, final.id, {
			...facts,
			route: "issue",
			transport: "gh",
			state: "sent",
			url: result.url,
			number: result.number,
			sentAt: (deps.now ?? (() => new Date()))().toISOString(),
		});
	else if (result.status !== "failed") updateOutbox(deps.stateDir, final.id, facts);
	return { kind: "sent", result, draft: final, rendered: finalRendered, verdict };
}

/** One line for the outcome of a send, shared by the CLI and the TUI's last step. */
export function sentLine(result: SendResult): string {
	switch (result.status) {
		case "sent":
			return `Sent: ${result.url}`;
		case "commented":
			return `Added to #${result.number}: ${result.url}`;
		case "reacted":
			return `Added a +1 to #${result.number}: ${result.url}`;
		case "opened":
			return `Opened your browser at ${result.url.split("?")[0]}; submit the form there to post it. The full text is in ${result.path}${result.cut ? " (the link holds only part of it)" : ""}.`;
		case "written":
			return `Wrote ${result.path}. Post it at ${result.url}.`;
		case "failed":
			return `Not sent: ${result.reason}. The text is in ${result.path}.`;
	}
}

export const REPORT_THANKS = "Thank you. Reports like this are how Clio gets fixed.";
export const REPORT_DRAFT_SAVED = "saved as a draft; /report status";

/** One report as every status view lists it: the outbox, plus saved drafts the outbox has no entry for. */
export interface ReportRow {
	id: string;
	kind: ReportKind;
	title: string;
	state: string;
	url: string | null;
	consent: string;
	credit: boolean;
}

/** Every report on this machine, newest first. */
export function reportRows(stateDir: string): ReportRow[] {
	const outbox = readOutbox(stateDir);
	const rows: ReportRow[] = Object.entries(outbox).map(([id, entry]) => ({
		id,
		kind: entry.kind,
		title: entry.title,
		state: entry.state,
		url: entry.url,
		consent: entry.consent,
		credit: entry.credit,
	}));
	for (const id of listReportDrafts(stateDir)) {
		if (outbox[id] !== undefined) continue;
		const draft = readReportDraft(stateDir, id);
		if (draft !== null)
			rows.push({
				id,
				kind: draft.kind,
				title: draft.title,
				state: "draft",
				url: null,
				consent: "none",
				credit: draft.credit === true,
			});
	}
	return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Delete a local draft. A report that already left this machine is refused: Clio cannot withdraw a public post. */
export function forgetReport(stateDir: string, id: string): { ok: true } | { ok: false; reason: string } {
	const entry = outboxEntry(stateDir, id);
	if (entry !== null && (entry.state === "sent" || entry.state === "sending" || entry.state === "opened"))
		return {
			ok: false,
			reason: `${id} already left this machine${entry.url !== null ? ` (${entry.url})` : ""}. Clio cannot withdraw a public report; edit or close it on GitHub.`,
		};
	if (entry === null && readReportDraft(stateDir, id) === null) return { ok: false, reason: `no report ${id}` };
	deleteReportBundle(stateDir, id);
	deleteReportDraft(stateDir, id);
	if (entry !== null) updateOutbox(stateDir, id, { kind: entry.kind, title: entry.title, state: "withdrawn" });
	return { ok: true };
}
