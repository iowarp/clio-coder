/**
 * `/report` where there is no review overlay to press send in (ACP, and the GUI that reads its catalog): the
 * preview is one command's text and sending is a second, deliberate command. Nothing here sends during a preview.
 */

import { createHash } from "node:crypto";
import { rememberIdentity } from "./body.js";
import type { ReportCommandRunner } from "./command.js";
import type { ReportSessionFacts } from "./environment.js";
import { observeSession } from "./observe.js";
import { outboxEntry, updateOutbox } from "./outbox.js";
import {
	composeReportDraft,
	forgetReport,
	planReport,
	REPORT_THANKS,
	type ReportPlan,
	type ReportPlanTransport,
	relatedLine,
	reportRows,
	runReportSend,
	sentLine,
} from "./plan.js";
import { type IdentitySettings, localIdentity } from "./scrub.js";
import { readReportDraft, saveReportDraft } from "./store.js";
import { detectTransport, type ReportTransport, routeFor } from "./transport.js";
import type { ReportKind } from "./vocabulary.js";

export interface ReportTextReply {
	level: "info" | "success" | "warn" | "error";
	text: string;
	/** The draft the reply is about and its outbox state, for a client that builds its own dialog. */
	report?: { draftId: string; state: string };
}

export type ReportTextDuplicate = { comment: number } | "new";

export interface ReportTextHost {
	plan(input: { kind: ReportKind | "security"; summary?: string }): Promise<ReportTextReply>;
	send(draftId: string, choices?: { duplicate?: ReportTextDuplicate }): Promise<ReportTextReply>;
	status(): Promise<ReportTextReply>;
	forget(id: string): Promise<ReportTextReply>;
}

export interface ReportTextDeps {
	stateDir: string;
	cwd: () => string;
	session?: () => { id: string; facts?: ReportSessionFacts } | null;
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

/** Body lines a text preview shows, so the actions, gates and send line still fit an ACP command result. */
const REPORT_TEXT_BODY_LINES = 150;

/** The plan as text: destination, title, the body in a fence, masks, the numbered actions and how to send it. */
export function formatReportPlanText(plan: ReportPlan, draftId: string): string {
	const body = plan.rendered.body.replace(/\n$/u, "");
	const fence = body.includes("```") ? "~~~~" : "```";
	const shownLines = body.split("\n").filter((line) => line.trim() !== "");
	const hidden = Math.max(0, shownLines.length - REPORT_TEXT_BODY_LINES);
	return [
		`${plan.postedAs === "writes a file" ? "Writes a file for" : "Goes to"} ${plan.destination} (${plan.postedAs}); nothing sent yet`,
		`Draft: ${draftId}`,
		`Title: ${plan.rendered.title}`,
		hidden > 0
			? `Body (${Buffer.byteLength(plan.rendered.body, "utf8")} bytes; this view leaves out blank lines and shows the first ${REPORT_TEXT_BODY_LINES} lines):`
			: `Body, exactly as it will be sent (${Buffer.byteLength(plan.rendered.body, "utf8")} bytes; this view leaves out blank lines):`,
		`${fence}markdown`,
		hidden > 0 ? shownLines.slice(0, REPORT_TEXT_BODY_LINES).join("\n") : body,
		fence,
		...(hidden > 0
			? [`${hidden} more body lines are not shown here; \`clio-coder report show ${draftId}\` shows the whole body.`]
			: []),
		plan.maskSummary,
		"No diagnostic bundle is attached.",
		...(plan.credit ? ["Credit: the report block asks for credit in the release notes (credit: yes)."] : []),
		"Sending will, in this order:",
		...plan.actions.map((action, index) => `  ${index + 1}. ${action}`),
		...(plan.rateWarning !== null ? [plan.rateWarning] : []),
		...(plan.gates.length > 0 ? ["Cannot send yet:", ...plan.gates.map((gate) => `  - ${gate}`)] : []),
		`Nothing was sent. To send: \`/report send ${draftId}\`. To change the text, run \`clio-coder report show ${draftId}\` in a terminal, or ask the agent to redraft.`,
	].join("\n");
}

export function createReportTextHost(deps: ReportTextDeps): ReportTextHost {
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
	// The exact text this host last showed per draft. A draft saved elsewhere (the agent's report tool, a shell), or
	// rewritten on disk after its preview, is shown here again before any send, so an ACP send always follows a
	// preview of that exact text.
	const shown = new Map<string, string>();
	const digest = (rendered: { title: string; body: string }): string =>
		createHash("sha256").update(`${rendered.title}\0${rendered.body}`).digest("hex");

	return {
		async plan(input) {
			if (input.kind === "security") {
				const route = routeFor("security");
				return {
					level: "info",
					text: `Security problems go to a private advisory, not a public issue. Only the maintainers see it:\n${route.name === "security" ? route.url : ""}`,
				};
			}
			const current = deps.session?.() ?? null;
			const who = await identity();
			const composed = composeReportDraft({
				kind: input.kind,
				surface: "acp",
				// ACP has no editor, so the summary is also the "What happened" text.
				...(input.summary !== undefined ? { title: input.summary, happened: input.summary } : {}),
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
			// Shown with this directory's identity, so a later resume elsewhere still masks what this preview masked.
			const draft = rememberIdentity(composed, who);
			const plan = planReport(draft, { identity: who, transport: await offline(), stateDir: deps.stateDir });
			saveReportDraft(deps.stateDir, draft);
			updateOutbox(deps.stateDir, draft.id, { kind: draft.kind, title: plan.rendered.title, state: "draft" });
			shown.set(draft.id, digest(plan.rendered));
			return {
				level: plan.gates.length > 0 ? "warn" : "info",
				text: formatReportPlanText(plan, draft.id),
				report: { draftId: draft.id, state: "draft" },
			};
		},

		async send(draftId, choices = {}) {
			const entry = outboxEntry(deps.stateDir, draftId);
			if (entry !== null && (entry.state === "sent" || entry.state === "withdrawn"))
				return {
					level: "info",
					text: `${draftId} is already ${entry.state}${entry.url !== null ? `: ${entry.url}` : ""}`,
					report: { draftId, state: entry.state },
				};
			const draft = readReportDraft(deps.stateDir, draftId);
			if (draft === null) return { level: "error", text: `no saved draft ${draftId}; /report status lists them` };
			// An agent's draft is sent only from the operator's terminal review, here as in the CLI.
			if (draft.origin === "agent")
				return {
					level: "warn",
					text: `Nothing was sent. An agent's draft is reviewed in a terminal: run \`clio-coder report send ${draftId}\` yourself.`,
					report: { draftId, state: "draft" },
				};
			const who = await identity();
			const plan = planReport(draft, { identity: who, transport: { kind: "file" }, stateDir: deps.stateDir });
			if (plan.gates.length > 0)
				return {
					level: "warn",
					text: [
						`Nothing was sent. ${draftId} cannot be sent yet:`,
						...plan.gates.map((gate) => `  - ${gate}`),
						`Run \`clio-coder report send ${draftId}\` in a terminal to edit it.`,
					].join("\n"),
					report: { draftId, state: "draft" },
				};
			const seen = shown.get(draftId);
			if (seen !== digest(plan.rendered)) {
				shown.set(draftId, digest(plan.rendered));
				const preview = planReport(draft, { identity: who, transport: await offline(), stateDir: deps.stateDir });
				const lead =
					seen === undefined
						? `${draftId} was not shown here before, so here it is first.`
						: `Nothing was sent. ${draftId} changed since it was shown here, so here it is again.`;
				return {
					level: "info",
					text: `${lead}\n${formatReportPlanText(preview, draftId)}`,
					report: { draftId, state: "draft" },
				};
			}
			const gh = await findGh();
			const transport = await (deps.detect ?? ((e) => detectTransport(e, { findGh: () => gh })))(env).catch(
				(): ReportTransport => ({ kind: "file" }),
			);
			let matches: string[] = [];
			const outcome = await runReportSend(draft, plan.rendered, {
				stateDir: deps.stateDir,
				identity: who,
				transport,
				env,
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
					matches = [
						"This may already be reported:",
						`  ${"issue" in verdict ? relatedLine(verdict.issue) : ""}`,
						...(verdict.kind === "upgrade"
							? [`  You are on ${verdict.installed}; the latest is ${verdict.latest}. Upgrading first may fix it.`]
							: []),
						"Nothing was sent. Choose one:",
						...(allowed.includes("comment") ? [`  /report send ${draftId} --comment ${number}`] : []),
						...(allowed.includes("new") ? [`  /report send ${draftId} --new`] : []),
						"  or do nothing",
					];
					return "stop";
				},
			});
			if (outcome.kind === "stopped")
				return { level: "warn", text: matches.join("\n"), report: { draftId: outcome.draft.id, state: "draft" } };
			const result = outcome.result;
			const state = outboxEntry(deps.stateDir, outcome.draft.id)?.state ?? "draft";
			return {
				level: result.status === "failed" ? "error" : "success",
				text: result.status === "failed" ? sentLine(result) : `${sentLine(result)}\n${REPORT_THANKS}`,
				report: { draftId: outcome.draft.id, state },
			};
		},

		async status() {
			const rows = reportRows(deps.stateDir);
			if (rows.length === 0) return { level: "info", text: "no reports yet; /report bug <summary> starts one" };
			const lines = ["id | state | kind | title | url"];
			for (const row of rows)
				lines.push(
					[
						row.id,
						row.state,
						row.kind,
						row.title,
						row.url ?? "",
						...(row.lastSeen !== null ? [`GitHub: ${row.lastSeen}`] : []),
					].join(" | "),
				);
			return { level: "info", text: lines.join("\n") };
		},

		async forget(id) {
			const result = forgetReport(deps.stateDir, id);
			if (!result.ok) return { level: "error", text: result.reason };
			return { level: "success", text: result.message };
		},
	};
}
