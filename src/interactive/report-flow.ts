/**
 * The terminal's `/report` host: it composes the draft, opens the review, and runs the send the operator pressed.
 * Loaded on first use, with the report domain behind it, so a session that never reports pays nothing at boot.
 */

import { editTextExternally, resolveExternalEditor } from "../core/external-editor.js";
import { canOpenBrowser, openBrowser } from "../core/open-browser.js";
import {
	applyReportEdit,
	composeReportDraft,
	detectTransport,
	forgetReport,
	type IdentitySettings,
	type LocalIdentity,
	localIdentity,
	observeSessionAsync,
	outboxEntry,
	planReport,
	REPORT_DRAFT_SAVED,
	type ReportDraft,
	type ReportOfferPrefill,
	type ReportPlanTransport,
	type ReportSessionFacts,
	type ReportTransport,
	readReportDraft,
	refreshReportStatus,
	reportEditTemplate,
	reportRows,
	routeFor,
	runReportSend,
	saveReportDraft,
	sentLine,
	setReplyCheck,
	updateOutbox,
} from "../domains/report/index.js";
import type { TUI } from "../engine/tui.js";
import type { SlashReportRequest } from "../session-control/slash-commands.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openListOverlay } from "./overlays/list-overlay.js";
import { openReportReviewOverlay, type ReportReviewDone } from "./overlays/report-review.js";

export interface ReportHostDeps {
	tui: TUI;
	transitions: OverlayTransitions;
	stateDir: string;
	notify(level: InteractiveNoticeLevel, text: string, key?: string): void;
	terminal?: { columns: number };
	/** Stop and restart the terminal around `$EDITOR`. */
	suspendTerminal?<T>(run: () => T): T;
	session?: () => { id: string; cwd?: string; facts: ReportSessionFacts } | null;
	identitySettings?: () => IdentitySettings;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	findGh?: () => string | null;
	detect?: (env: NodeJS.ProcessEnv) => Promise<ReportTransport>;
	openReview?: typeof openReportReviewOverlay;
	/** The report offer on screen, consumed by a bug report so its draft carries the offer's trigger and fingerprint. */
	takeOffer?: () => ReportOfferPrefill | null;
}

export interface ReportHost {
	open(request: SlashReportRequest): void;
	status(): void;
	forget(id: string): void;
}

/** Why `/report` cannot open now, or null when it can. An approval waiting on the operator always wins. */
function refusal(transitions: OverlayTransitions): string | null {
	if (transitions.state === "closed") return null;
	if (transitions.state === "permission-confirm") return "an approval is waiting; answer it, then run /report again";
	return "close the open panel first, then run /report again";
}

export function createReportHost(deps: ReportHostDeps): ReportHost {
	const env = deps.env ?? process.env;
	const cwd = (): string => deps.session?.()?.cwd ?? deps.cwd ?? process.cwd();

	const findGh = async (): Promise<string | null> => {
		if (deps.findGh) return deps.findGh();
		const { resolveToolBinary } = await import("../domains/toolchain/index.js");
		return resolveToolBinary("gh").binaryPath;
	};

	const keepDraft = (draft: ReportDraft, title: string): void => {
		saveReportDraft(deps.stateDir, draft);
		// A `sending` entry stays so: its last create may have filed, and the next send checks for it first.
		const state = outboxEntry(deps.stateDir, draft.id)?.state === "sending" ? "sending" : "draft";
		updateOutbox(deps.stateDir, draft.id, { kind: draft.kind, title, state });
	};

	const edit = (draft: ReportDraft): ReportDraft | null => {
		const command = resolveExternalEditor(env);
		if (!command) {
			deps.notify("warning", "report: no external editor configured; set VISUAL or EDITOR", "report:no-editor");
			return null;
		}
		const suspend = deps.suspendTerminal ?? (<T>(run: () => T): T => run());
		const result = suspend(() => editTextExternally(reportEditTemplate(draft), command));
		if (result.ok && result.text !== undefined) return applyReportEdit(draft, result.text);
		if (result.error) deps.notify("warning", `report: ${result.error}`, "report:editor-failed");
		return null;
	};

	const announce = (done: ReportReviewDone): void => {
		if (done.kind === "error") {
			deps.notify("warning", `report not sent: ${done.message}; ${REPORT_DRAFT_SAVED}`, "report:failed");
			return;
		}
		const outcome = done.outcome;
		if (outcome.kind === "stopped") deps.notify("info", `report: nothing sent; ${REPORT_DRAFT_SAVED}`, "report:stopped");
		else deps.notify(outcome.result.status === "failed" ? "warning" : "success", `report: ${sentLine(outcome.result)}`);
	};

	async function review(draft: ReportDraft): Promise<void> {
		const identity: LocalIdentity = await localIdentity(cwd(), deps.identitySettings?.() ?? {}, { env });
		// Opened against what is on this machine; who gh is signed in as arrives a moment later and the plan follows.
		const gh = await findGh();
		let shown: ReportPlanTransport =
			gh !== null ? { kind: "gh", login: null } : canOpenBrowser(env) ? { kind: "browser" } : { kind: "file" };
		let detected: ReportTransport | null = null;
		const detection = (deps.detect ?? ((e) => detectTransport(e, { findGh: () => gh })))(env).catch(
			(): ReportTransport => ({ kind: "file" }),
		);
		// The awaits above leave room for an approval to arrive first; it keeps the screen.
		const refused = refusal(deps.transitions);
		if (refused !== null) {
			deps.notify("warning", `report: ${refused}`, "report:refused");
			return;
		}
		const open = deps.openReview ?? openReportReviewOverlay;
		deps.transitions.state = "report-review";
		const session = open(deps.tui, {
			draft,
			columns: deps.terminal?.columns ?? 80,
			plan: (current) => planReport(current, { identity, transport: shown, stateDir: deps.stateDir }),
			ready: () => detected !== null,
			edit,
			send: (current, plan, choose, choices) => {
				if (detected === null) throw new Error("still checking how to send");
				return runReportSend(current, plan.rendered, {
					stateDir: deps.stateDir,
					identity,
					transport: detected,
					env,
					replyCheck: choices.replyCheck,
					chooseDuplicate: choose,
				});
			},
			onCancel: (current, plan) => {
				deps.transitions.close();
				keepDraft(current, plan.rendered.title);
				deps.notify("info", `report: nothing sent; ${REPORT_DRAFT_SAVED}`, "report:cancelled");
			},
			onDone: (done) => {
				deps.transitions.close();
				announce(done);
			},
		});
		deps.transitions.handle = session;
		void detection.then((transport) => {
			detected = transport;
			shown = transport;
			if (deps.transitions.handle === session) session.review.refresh();
		});
	}

	function start(task: () => Promise<void>): void {
		void task().catch((error: unknown) => {
			if (deps.transitions.state === "report-review") deps.transitions.close();
			deps.notify("error", `report: ${error instanceof Error ? error.message : String(error)}`, "report:error");
		});
	}

	function open(request: SlashReportRequest): void {
		const refused = refusal(deps.transitions);
		if (refused !== null) {
			deps.notify("warning", `report: ${refused}`, "report:refused");
			return;
		}
		if (request.kind === "security") {
			const route = routeFor("security");
			const url = route.name === "security" ? route.url : "";
			const opened = canOpenBrowser(env) && openBrowser(url, env);
			deps.notify(
				"info",
				`Security problems go to a private advisory, not a public issue; only the maintainers see it: ${url}${opened ? " (opened in your browser)" : ""}`,
				"report:security",
			);
			return;
		}
		if (request.kind === "draft") {
			const entry = outboxEntry(deps.stateDir, request.draftId);
			if (entry !== null && (entry.state === "sent" || entry.state === "withdrawn")) {
				deps.notify("info", `report: ${request.draftId} is already ${entry.state}${entry.url ? `: ${entry.url}` : ""}`);
				return;
			}
			const saved = readReportDraft(deps.stateDir, request.draftId);
			if (saved === null) {
				deps.notify("warning", `report: no saved draft ${request.draftId}; /report status lists them`);
				return;
			}
			start(() => review(saved));
			return;
		}
		const current = deps.session?.() ?? null;
		const kind = request.kind;
		const summary = request.summary;
		const offer = kind === "bug" ? (deps.takeOffer?.() ?? null) : null;
		start(async () => {
			const draft = composeReportDraft({
				kind,
				surface: "tui",
				...(offer !== null ? { offer } : {}),
				...(summary !== undefined ? { title: summary } : {}),
				session:
					current === null
						? null
						: {
								id: current.id,
								observations: await observeSessionAsync(deps.stateDir, current.id),
								facts: current.facts,
							},
			});
			await review(draft);
		});
	}

	function status(options: { refresh?: boolean } = {}): void {
		const refused = refusal(deps.transitions);
		if (refused !== null) {
			deps.notify("warning", `report: ${refused}`, "report:refused");
			return;
		}
		const rows = reportRows(deps.stateDir);
		deps.transitions.state = "report-status";
		const handle = openListOverlay(deps.tui, {
			markerId: "report-status",
			title: "Your reports",
			unit: "reports",
			layout: "split",
			emptyMessage: "No reports yet.",
			emptyRemedy: "/report bug <summary> starts one.",
			items: rows.map((row) => ({
				id: row.id,
				label: row.title.length > 0 ? row.title : "(no title yet)",
				meta: row.state,
				detail: () => [
					`kind: ${row.kind}`,
					`state: ${row.state}`,
					...(row.url !== null ? [`url: ${row.url}`] : []),
					`consented to: ${row.consent === "none" ? "the public text only; no bundle" : row.consent}`,
					`credit: ${row.credit ? "yes" : "no"}`,
					...(row.state === "sent" ? [`reply check: ${row.replyCheck ? "on, once a day" : "off"}`] : []),
					...(row.lastSeen !== null ? [`GitHub: ${row.lastSeen}`] : []),
					`id: ${row.id}`,
					...(row.state === "draft" ? ["", "Enter reviews it; /report forget <id> deletes it."] : []),
					...(row.replyCheck ? ["", "r turns the daily reply check off."] : []),
				],
				detailFormat: "rows" as const,
			})),
			hints: (selected) => [
				...(selected?.meta === "draft" ? [{ key: "Enter", verb: "review and send", short: "review", critical: true }] : []),
				...(selected !== undefined && rows.find((row) => row.id === selected.id)?.replyCheck
					? [{ key: "r", verb: "stop checking for replies", short: "no replies" }]
					: []),
			],
			actions: {
				r: (item) => {
					if (!rows.find((row) => row.id === item.id)?.replyCheck) return;
					setReplyCheck(deps.stateDir, item.id, false);
					deps.notify("info", `report: no more reply checks for ${item.id}`, "report:reply-check");
					deps.transitions.close();
					status({ refresh: false });
				},
			},
			onSelect: (item) => {
				if (item.meta !== "draft") return;
				deps.transitions.close();
				open({ kind: "draft", draftId: item.id });
			},
			onClose: () => deps.transitions.close(),
		});
		deps.transitions.handle = handle;
		if (options.refresh === false) return;
		// The operator asked, so this reads GitHub with no further consent; the list reopens with what it said.
		void (async () => {
			const gh = await findGh();
			if (gh === null || !rows.some((row) => row.state === "sent")) return;
			await refreshReportStatus(deps.stateDir, { findGh: () => gh, env });
			if (deps.transitions.handle !== handle) return;
			deps.transitions.close();
			status({ refresh: false });
		})().catch(() => {
			// The stored state is already on screen; a failed read leaves it there.
		});
	}

	function forget(id: string): void {
		const result = forgetReport(deps.stateDir, id);
		if (result.ok) deps.notify("success", `report: forgot ${id}; its local draft is deleted`);
		else
			deps.notify(
				"warning",
				`report: ${result.reason}${result.reason.startsWith("no report") ? "; /report status lists them" : ""}`,
			);
	}

	return { open, status: () => status(), forget };
}
