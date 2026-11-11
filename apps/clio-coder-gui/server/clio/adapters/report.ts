import { readClioVersion } from "../../../../../src/core/package-root.js";
import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import { resolveClioDirs } from "../../../../../src/core/xdg.js";
import {
	createReportDialogHost,
	ReportDialogError,
	type ReportDialogHost,
} from "../../../../../src/domains/report/dialog-flow.js";
import {
	type BuiltBundle,
	buildBundle,
	consentText,
	createOfferTriggers,
	draftIdentity,
	isFirstSession,
	localIdentity,
	type OfferCandidate,
	observeSession,
	offerRefusal,
	previewBundle,
	readOfferLedger,
	readReportDraft,
	recordOfferShown,
	saveBuiltBundle,
} from "../../../../../src/domains/report/index.js";
import type {
	ProblemReportBundle,
	ProblemReportBundleRequest,
	ProblemReportChoices,
	ProblemReportEdits,
	ProblemReportOffer,
	ProblemReportPlanRequest,
} from "../../../contracts/problem-reports.js";
import { AppProblem } from "../../services/problem.js";

/**
 * The desktop report dialog's host side (R-24): thin calls into the report domain's dialog flow, which plans with
 * the same `planReport` and sends with the same `runReportSend` as the terminal and ACP. Runs in the ops lane, so
 * `gh` and the browser opener run with this process's environment, as other operations do.
 */
const hosts = new Map<string, ReportDialogHost>();
function identitySettings(cwd: string) {
	try {
		return { targets: readLayeredSettings(cwd).settings.targets };
	} catch {
		// Unreadable settings mask no target names; every other identity value still applies.
		return {};
	}
}
function hostFor(cwd: string): ReportDialogHost {
	let host = hosts.get(cwd);
	if (host === undefined) {
		host = createReportDialogHost({
			stateDir: resolveClioDirs().state,
			cwd: () => cwd,
			session: (id) => (id === undefined ? null : { id }),
			identitySettings: () => identitySettings(cwd),
		});
		hosts.set(cwd, host);
	}
	return host;
}
async function mapped<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ReportDialogError)
			throw new AppProblem(error.code === "not-found" ? "not_found" : "validation", error.message);
		throw error;
	}
}

/** The bundle each Attach step built and showed, by draft; written only when that draft is sent with consent. */
const shownBundles = new Map<string, BuiltBundle>();

/** The domain's bundle builder, without writing: what the Attach step shows and the viewer pages. */
async function bundle(cwd: string, draftId: string, request: ProblemReportBundleRequest): Promise<ProblemReportBundle> {
	const stateDir = resolveClioDirs().state;
	const draft = readReportDraft(stateDir, draftId);
	if (draft === null) throw new AppProblem("not_found", `no saved draft ${draftId}`);
	let built: BuiltBundle;
	try {
		built = await buildBundle(draft, {
			// The scope the consent radio names; nothing is written or attached until Send carries that consent.
			consent: { scopes: ["debug"] },
			...(request.transcript ? { transcript: {} } : {}),
			identity: draftIdentity(draft, await localIdentity(cwd, identitySettings(cwd))),
			stateDir,
			write: false,
		});
	} catch (error) {
		shownBundles.delete(draftId);
		throw new AppProblem(
			"validation",
			`No bundle was built: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	shownBundles.set(draftId, built);
	const { summary } = built;
	const text = consentText();
	const { readable } = summary;
	return {
		draftId,
		sha256: built.sha256,
		bytes: summary.bytes,
		transcript: summary.transcript === null ? null : { turns: summary.transcript.turns, of: summary.transcript.of },
		readable: {
			model: [...readable.model],
			runtime: [...readable.runtime],
			tool: [...readable.tool],
			token: [...readable.token],
		},
		anonymized: Object.entries(summary.anonymized)
			.filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
			.map(([kind, count]) => ({ kind, count })),
		withheld: summary.withheld,
		kept: [...summary.kept],
		neverKept: [...summary.neverKept],
		consent: { debug: text.debug, transcript: text.transcript },
		members: previewBundle(built.bytes).sections,
	};
}

/**
 * Sends through the domain's dialog flow. The bundle the Attach step showed is written beside the report only when
 * the send step's consent radio said so and Send was pressed; any other choice drops it, and a consent without a
 * shown bundle sends nothing.
 */
async function send(cwd: string, draftId: string, choices: ProblemReportChoices) {
	const { bundle: attach, ...rest } = choices;
	if (rest.consent === true && attach === "debug") {
		const built = shownBundles.get(draftId);
		const stateDir = resolveClioDirs().state;
		const draft = readReportDraft(stateDir, draftId);
		if (built === undefined || draft === null)
			return {
				status: "blocked" as const,
				draftId,
				state: "draft",
				reasons: ["Nothing was sent: open the Attach step to build the bundle you agree to attach."],
			};
		saveBuiltBundle(stateDir, draft, built);
	}
	if (attach !== "debug" || rest.consent !== true) shownBundles.delete(draftId);
	return mapped(() => hostFor(cwd).send(draftId, rest));
}

/**
 * The domain's offer rules for a failure this session recorded: the trigger table over the session's observations,
 * then `offerRefusal` against the ledger and the `report.offers` setting. A shown offer is recorded in the ledger.
 */
async function offer(cwd: string, sessionId: string): Promise<ProblemReportOffer> {
	const stateDir = resolveClioDirs().state;
	let setting: "ask" | "off" = "ask";
	try {
		setting = readLayeredSettings(cwd).settings.report.offers;
	} catch {
		// Unreadable settings offer nothing.
		setting = "off";
	}
	if (setting === "off") return { offer: null, refusal: "setting-off" };
	const triggers = createOfferTriggers(readClioVersion());
	let candidate: OfferCandidate | null = null;
	for (const observation of observeSession(stateDir, sessionId)) {
		const next =
			observation.code === "turn-ended" && observation.values.cause !== null
				? triggers.turnSettled(observation.values.cause as Parameters<typeof triggers.turnSettled>[0])
				: observation.code === "compaction"
					? triggers.compactionSettled(observation.values.outcome)
					: null;
		if (next !== null) candidate = next;
	}
	if (candidate === null) return { offer: null, refusal: "nothing-to-offer" };
	const now = new Date();
	const refusal = offerRefusal(candidate, now.getTime(), {
		id: sessionId,
		offers: setting,
		ledger: readOfferLedger(stateDir),
		turnRunning: false,
		attended: true,
		firstSession: isFirstSession(),
	});
	if (refusal !== null) return { offer: null, refusal };
	recordOfferShown(stateDir, sessionId, now);
	return { offer: { text: candidate.text, fingerprint: candidate.fingerprint }, refusal: null };
}

export const reportDialog = {
	plan: (cwd: string, input: ProblemReportPlanRequest) => mapped(() => hostFor(cwd).plan(input)),
	update: (cwd: string, draftId: string, edits: ProblemReportEdits) => mapped(() => hostFor(cwd).update(draftId, edits)),
	send,
	bundle,
	offer,
	status: async (cwd: string) => ({ rows: await hostFor(cwd).status() }),
};
