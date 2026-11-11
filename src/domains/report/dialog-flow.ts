/**
 * `/report` for a client that draws its own dialog (the desktop app): the same draft, the same `planReport` and the
 * same `runReportSend` as the terminal and ACP flows, returned as data. The client never composes what is sent; it
 * shows `plan.rendered` and sends a draft id back. Nothing here sends during plan or update.
 */

import { rememberIdentity } from "./body.js";
import type { ReportCommandRunner } from "./command.js";
import type { ReportSessionFacts } from "./environment.js";
import { observeSession } from "./observe.js";
import { outboxEntry, updateOutbox } from "./outbox.js";
import {
	composeReportDraft,
	planHeadline,
	planReport,
	REPORT_THANKS,
	type ReportPlan,
	type ReportPlanTransport,
	type ReportRow,
	relatedLine,
	reportRows,
	runReportSend,
	sentLine,
} from "./plan.js";
import { type IdentitySettings, localIdentity, type ReportMask, SECRET_MASK_ID } from "./scrub.js";
import { readReportDraft, saveReportDraft } from "./store.js";
import { detectTransport, type ReportTransport } from "./transport.js";
import type { ReportKind } from "./vocabulary.js";

export interface ReportDialogDeps {
	stateDir: string;
	cwd: () => string;
	session?: (id?: string) => { id: string; facts?: ReportSessionFacts } | null;
	identitySettings?: () => IdentitySettings;
	env?: NodeJS.ProcessEnv;
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	browserAvailable?: (env: NodeJS.ProcessEnv) => boolean;
	detect?: (env: NodeJS.ProcessEnv) => Promise<ReportTransport>;
	open?: (url: string) => boolean;
	changelog?: string | null;
	now?: () => Date;
}

/** One mask as the dialog's chip: kind and count only; the masked value never leaves the host. */
export interface ReportDialogMask extends ReportMask {
	masked: boolean;
	locked: boolean;
}

export interface ReportDialogView {
	draftId: string;
	state: string;
	/** "Public, posted from your gh account to github.com/..." */
	headline: string;
	plan: ReportPlan;
	masks: ReportDialogMask[];
	fields: { title: string; happened: string; expected: string; reproduce: string };
	/** False for an agent's draft: it is sent only from the operator's terminal review. */
	sendable: boolean;
}

export interface ReportDialogEdits {
	title?: string;
	happened?: string;
	expected?: string;
	reproduce?: string;
	/** Mask ids to let through; the secret mask is always kept. */
	unmasked?: string[];
	credit?: boolean;
}

export interface ReportDialogChoices {
	/** The reporter pressed Send on this exact text; anything else sends nothing. */
	consent: boolean;
	replyCheck?: boolean;
	duplicate?: { comment: number } | "new";
}

export type ReportDialogSent =
	| { status: "sent"; draftId: string; state: string; line: string; url: string | null }
	| { status: "failed"; draftId: string; state: string; line: string }
	| { status: "duplicates"; draftId: string; state: string; related: string; comment: number | null; allowNew: boolean }
	| { status: "blocked"; draftId: string; state: string; reasons: string[] };

export interface ReportDialogHost {
	plan(input: { kind: ReportKind; summary?: string; sessionId?: string }): Promise<ReportDialogView>;
	update(draftId: string, edits: ReportDialogEdits): Promise<ReportDialogView>;
	send(draftId: string, choices: ReportDialogChoices): Promise<ReportDialogSent>;
	status(): Promise<ReportRow[]>;
}

export class ReportDialogError extends Error {
	constructor(
		readonly code: "not-found" | "validation",
		message: string,
	) {
		super(message);
	}
}

export function createReportDialogHost(deps: ReportDialogDeps): ReportDialogHost {
	const env = deps.env ?? process.env;
	const identity = () =>
		localIdentity(deps.cwd(), deps.identitySettings?.() ?? {}, {
			env,
			...(deps.run !== undefined ? { run: deps.run } : {}),
		});
	const findGh = async (): Promise<string | null> => {
		if (deps.findGh) return deps.findGh();
		const { resolveToolBinary } = await import("../toolchain/index.js");
		return resolveToolBinary("gh").binaryPath;
	};
	// The preview names the transport from what is on this machine; it never asks GitHub who is signed in.
	const offline = async (): Promise<ReportPlanTransport> => {
		if ((await findGh()) !== null) return { kind: "gh", login: null };
		const browser = deps.browserAvailable ?? (await import("../../core/open-browser.js")).canOpenBrowser;
		return browser(env) ? { kind: "browser" } : { kind: "file" };
	};
	const load = (draftId: string) => {
		const draft = readReportDraft(deps.stateDir, draftId);
		if (draft === null) throw new ReportDialogError("not-found", `no saved draft ${draftId}`);
		return draft;
	};
	const view = async (draft: ReturnType<typeof load>): Promise<ReportDialogView> => {
		const who = await identity();
		const transport = await offline();
		const plan = planReport(draft, { identity: who, transport, stateDir: deps.stateDir });
		// Every mask the text would carry, so a chip the reporter let through stays on screen to tick back.
		const all = planReport({ ...draft, unmasked: [] }, { identity: who, transport, stateDir: deps.stateDir }).masks;
		return {
			draftId: draft.id,
			state: outboxEntry(deps.stateDir, draft.id)?.state ?? "draft",
			headline: planHeadline(plan),
			plan,
			masks: all.map((mask) => {
				const locked = mask.id === SECRET_MASK_ID;
				return { ...mask, locked, masked: locked || !draft.unmasked.includes(mask.id) };
			}),
			fields: {
				title: draft.title,
				happened: draft.sections.happened,
				expected: draft.sections.expected,
				reproduce: draft.sections.reproduce,
			},
			sendable: draft.origin !== "agent",
		};
	};

	return {
		async plan(input) {
			const current = deps.session?.(input.sessionId) ?? null;
			const who = await identity();
			const composed = composeReportDraft({
				kind: input.kind,
				surface: "gui",
				...(input.summary !== undefined ? { title: input.summary } : {}),
				session:
					current === null
						? null
						: {
								id: current.id,
								observations: observeSession(deps.stateDir, current.id),
								...(current.facts ? { facts: current.facts } : {}),
							},
				...(deps.now ? { now: deps.now() } : {}),
			});
			const draft = rememberIdentity(composed, who);
			saveReportDraft(deps.stateDir, draft);
			const shown = await view(draft);
			updateOutbox(deps.stateDir, draft.id, { kind: draft.kind, title: shown.plan.rendered.title, state: "draft" });
			return { ...shown, state: "draft" };
		},

		async update(draftId, edits) {
			const draft = load(draftId);
			const entry = outboxEntry(deps.stateDir, draftId);
			if (entry !== null && (entry.state === "sent" || entry.state === "withdrawn"))
				throw new ReportDialogError("validation", `${draftId} is already ${entry.state}`);
			const next = {
				...draft,
				title: edits.title ?? draft.title,
				sections: {
					...draft.sections,
					...(edits.happened !== undefined ? { happened: edits.happened } : {}),
					...(edits.expected !== undefined ? { expected: edits.expected } : {}),
					...(edits.reproduce !== undefined ? { reproduce: edits.reproduce } : {}),
				},
				...(edits.unmasked !== undefined ? { unmasked: edits.unmasked.filter((id) => id !== SECRET_MASK_ID) } : {}),
				...(edits.credit !== undefined ? { credit: edits.credit } : {}),
			};
			saveReportDraft(deps.stateDir, next);
			return view(next);
		},

		async send(draftId, choices) {
			const entry = outboxEntry(deps.stateDir, draftId);
			if (entry !== null && (entry.state === "sent" || entry.state === "withdrawn"))
				return {
					status: "failed",
					draftId,
					state: entry.state,
					line: `${draftId} is already ${entry.state}${entry.url !== null ? `: ${entry.url}` : ""}`,
				};
			const draft = load(draftId);
			if (choices.consent !== true)
				return { status: "blocked", draftId, state: "draft", reasons: ["Nothing was sent: Send was not pressed."] };
			if (draft.origin === "agent")
				return {
					status: "blocked",
					draftId,
					state: "draft",
					reasons: [`An agent's draft is reviewed in a terminal: run \`clio-coder report send ${draftId}\` yourself.`],
				};
			const who = await identity();
			const plan = planReport(draft, { identity: who, transport: { kind: "file" }, stateDir: deps.stateDir });
			if (plan.gates.length > 0) return { status: "blocked", draftId, state: "draft", reasons: plan.gates };
			const gh = await findGh();
			const transport = await (deps.detect ?? ((e) => detectTransport(e, { findGh: () => gh })))(env).catch(
				(): ReportTransport => ({ kind: "file" }),
			);
			let duplicate: Extract<ReportDialogSent, { status: "duplicates" }> | null = null;
			const outcome = await runReportSend(draft, plan.rendered, {
				stateDir: deps.stateDir,
				identity: who,
				transport,
				env,
				...(choices.replyCheck === true ? { replyCheck: true } : {}),
				...(deps.run !== undefined ? { run: deps.run } : {}),
				...(deps.open !== undefined ? { open: deps.open } : {}),
				...(deps.now !== undefined ? { now: deps.now } : {}),
				related: {
					...(deps.changelog !== undefined ? { changelog: deps.changelog } : {}),
					...(deps.now !== undefined ? { now: deps.now } : {}),
				},
				chooseDuplicate: async (verdict, options) => {
					const allowed = options.map((option) => option.value);
					const wanted = choices.duplicate;
					const number = "issue" in verdict ? verdict.issue.number : null;
					if (wanted === "new" && allowed.includes("new")) return "new";
					if (typeof wanted === "object" && wanted.comment === number && allowed.includes("comment")) return "comment";
					duplicate = {
						status: "duplicates",
						draftId,
						state: "draft",
						related: "issue" in verdict ? relatedLine(verdict.issue) : "",
						comment: allowed.includes("comment") ? number : null,
						allowNew: allowed.includes("new"),
					};
					return "stop";
				},
			});
			if (outcome.kind === "stopped")
				return duplicate ?? { status: "blocked", draftId, state: "draft", reasons: ["Nothing was sent."] };
			const result = outcome.result;
			const state = outboxEntry(deps.stateDir, outcome.draft.id)?.state ?? "draft";
			if (result.status === "failed")
				return { status: "failed", draftId: outcome.draft.id, state, line: sentLine(result) };
			return {
				status: "sent",
				draftId: outcome.draft.id,
				state,
				line: `${sentLine(result)}\n${REPORT_THANKS}`,
				url: result.url,
			};
		},

		async status() {
			return reportRows(deps.stateDir);
		},
	};
}
