/**
 * Expanded footer pages: dense inspection, separate from transcript output style.
 *
 * Each page answers one operator question in its first rows and keeps the
 * detail beneath: Activity says what is running, Context says how full the
 * window is, Status says what the session costs and what the machine is doing.
 * The pages compose the shared primitives (chip rows, section rules, tables,
 * meters, fact rows) so a worker row here reads like a worker row on the Fleet
 * Runs board and a quota meter here reads like one in `/usage`.
 */

import { clioBuildLabel } from "../../core/build-info.js";
import { type FillSource, formatFill } from "../../core/format-time.js";
import { presentationTier, type TierPolicy, tierPolicy } from "../../core/presentation-tier.js";
import {
	compareRuns,
	type RunCell,
	type RunFacts,
	type RunOrigin,
	runCountBuckets,
	runCountRow,
	runIdentityWidth,
	runRow,
} from "../../core/run-row.js";
import { COST_NOT_MEASURED, renderUsdLimit } from "../../core/telemetry/render.js";
import { autonomyModeReadout, autonomyWindowReadout } from "../../domains/safety/autonomy-readout.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { tokensPerSecondText } from "../../session-control/assistant-generation-timing.js";
import { contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { ACTIVE_DISPATCH_STATUSES, formatFooterTokens } from "../footer-panel.js";
import { actionKeyLabel, formatKeyLabel } from "../keybinding-manager.js";
import { bindingQuotaWindow, bindingWindowPart, linkedQuotaAccounts, routeWeeklyQuota } from "../quota-view.js";
import { formatReasoningChip } from "../status/reasoning.js";
import {
	brandMark,
	type ClioTheme,
	type ClioToken,
	clioTheme,
	factRows,
	fitSides,
	formatElapsed,
	GLYPH,
	keyCap,
	meter,
	metricText,
	padAnsi,
	rule,
	type SideUnit,
	sectionRule,
	type Tone,
	widthClass,
} from "../theme/index.js";
import { fitIdentityLabel, fitPathLabel } from "../theme/labels.js";
import { economyReceipt } from "../usage-words.js";
import { contextReadingQualifier } from "./context-rail.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import { type Notification, notificationGlyph, notificationToken, topNotification } from "./notifications.js";
import type { LocalMachineMetrics } from "./system-metrics.js";
import { buildHarnessStatePill, lastTurnOutcome, taskBoardValue, zipColumns } from "./widgets.js";

/** A plan row stands for a whole fleet plan, and a finished one can predate this process. Neither is a worker. */
function workerRowsOf(rows: ReadonlyArray<DispatchBoardRow>): ReadonlyArray<DispatchBoardRow> {
	return rows.filter((row) => row.plan === undefined);
}

/** At this width and above a page lays its sections out in two columns. */
const FOOTER_SPLIT_COLUMNS = 84;
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

/** Two column blocks beside each other, or stacked when the page is narrow. */
function columns(left: string[], right: string[], width: number): string[] {
	if (width < FOOTER_SPLIT_COLUMNS) return [...left, ...right];
	const leftWidth = Math.floor((width - 3) / 2);
	return zipColumns(left, right, leftWidth, width - leftWidth - 3, "   ");
}

/**
 * The session's receipt as chips: the binding window of the account the main route draws on first, then the extra
 * cost, seat credits and API equivalent, each the S10 projection's own words. A part with an unknown keeps the neutral
 * tone. A declared fee is never a chip here: it belongs to its period, not to a turn or a session row.
 */
function receiptChips(theme: ClioTheme, state: FooterDashboardRenderState): string[] {
	const spend = state.telemetry;
	if (spend.kind !== "ready" || !spend.economy) return [];
	const binding = state.quotaRoute
		? bindingQuotaWindow(
				linkedQuotaAccounts(state.quota ?? [], {
					runtimeIds: [state.quotaRoute.runtimeId],
					targetIds: spend.economyTargets ?? [],
					node: state.quotaRoute.node,
				}),
			)
		: null;
	return economyReceipt(spend.economy, binding === null ? null : bindingWindowPart(binding, state.now)).map((part) =>
		theme.fg(part.unknown ? "unknownValue" : "counter", part.text),
	);
}

/** The longest bar a page meter draws; past this a wide terminal gets room, not resolution. */
const PAGE_METER_CELLS = 48;

/** `label ━━━━━━──── 62%` for a page meter whose tone names the limit it approaches. */
function pageMeter(label: string, value: number | null, max: number, width: number, amount?: string): string {
	const theme = clioTheme();
	if (value === null || !Number.isFinite(value)) {
		return `${theme.fg("fieldName", label)} ${theme.fg("unknownValue", "warming up")}`;
	}
	const ratio = max > 0 ? value / max : 0;
	const tone: Tone | "meter" = ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warning" : "meter";
	const shown = amount ?? `${Math.round(ratio * 100)}%`;
	const capped = Math.min(width, visibleWidth(label) + 1 + PAGE_METER_CELLS + 1 + visibleWidth(shown));
	return meter(theme, { label, value, max, width: capped, tone, amount: shown });
}

/**
 * The local machine: CPU, memory, GPU, network and disk, as the Health tab of
 * `/usage` shows them while it samples.
 */
export function machineBlock(resource: LocalMachineMetrics | null, now: number, width: number): string[] {
	const theme = clioTheme();
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const value = (text: string): string =>
		theme.fg(
			/^(unknown|unreported|unavailable|not sampled|sampling|warming up|pending|not available|not reported)/u.test(text)
				? "unknownValue"
				: "fieldValue",
			clean(text),
		);
	const facts = (entries: ReadonlyArray<readonly [string, string]>, room: number): string[] =>
		factRows(
			theme,
			entries.map(([label, text]) => ({ label, value: value(text), fit: "clip" as const })),
			room,
			{ labelWidth: 14 },
		);
	const half = Math.floor((width - 3) / 2);
	const cpu = pageMeter("CPU", resource ? resource.cpuPercent : null, 100, width >= FOOTER_SPLIT_COLUMNS ? half : width);
	const ramUsed = resource ? resource.hostTotalBytes - resource.hostFreeBytes : null;
	const ram = resource
		? pageMeter(
				"RAM",
				ramUsed,
				resource.hostTotalBytes,
				width >= FOOTER_SPLIT_COLUMNS ? width - half - 3 : width,
				`${Math.round(((ramUsed ?? 0) / resource.hostTotalBytes) * 100)}% ${theme.fg("fieldValue", `${gib(ramUsed ?? 0)} / ${gib(resource.hostTotalBytes)}`)}`,
			)
		: pageMeter("RAM", null, 100, width);
	const gpu = resource?.gpu
		? resource.gpu.busyPercent === null
			? `${theme.fg("fieldName", "GPU")} ${value(
					`${resource.gpu.name} · load unavailable${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` · ${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`
							: ""
					}`,
				)}`
			: pageMeter(
					`GPU ${clean(resource.gpu.name)}`,
					resource.gpu.busyPercent,
					100,
					width >= FOOTER_SPLIT_COLUMNS ? half : width,
					`${resource.gpu.busyPercent}%${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` ${theme.fg("fieldValue", `${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`)}`
							: ""
					}`,
				)
		: `${theme.fg("fieldName", "GPU")} ${value("unavailable on this OS/driver")}`;
	const rss = `${theme.fg("fieldName", "CLIO Coder RSS")} ${resource ? theme.fg("fieldValue", mib(resource.processRssBytes)) : value("sampling")}`;
	const machine = [
		sectionRule(theme, width, "Machine", {
			meta: resource
				? `${resource.scope} · sampled ${Math.max(0, Math.round((now - resource.sampledAt) / 1000))}s ago`
				: "local OS · sampling",
		}),
		...columns([cpu], [ram], width),
		...columns([gpu], [rss], width),
		...facts(
			[
				[
					"Network",
					resource?.network
						? `${resource.network.name} ${GLYPH.down} ${throughput(resource.network.receivedPerSecond)} ${GLYPH.up} ${throughput(resource.network.sentPerSecond)}`
						: "warming up / unavailable",
				],
				[
					"Disk I/O",
					resource?.disk
						? `${resource.disk.name} R ${throughput(resource.disk.readPerSecond)} W ${throughput(resource.disk.writtenPerSecond)}`
						: "warming up / unavailable",
				],
				["Sampling", resource ? "every 2s" : "pending"],
				["Scope", `${resource?.scope ?? "local OS"} · busiest interface/disk · local only`],
			],
			width,
		),
	];

	return machine;
}

/**
 * As many whole names as fit `room` after `prefix`, closing on `…` when some
 * did not; the first name is cut only when it alone does not fit.
 */
function fitNames(prefix: string, names: readonly string[], room: number): string {
	for (let kept = names.length; kept > 0; kept -= 1) {
		const candidate = `${prefix}${names.slice(0, kept).join(", ")}${kept < names.length ? GLYPH.ellipsis : ""}`;
		if (visibleWidth(candidate) <= room) return candidate;
	}
	return truncateToWidth(`${prefix}${names[0] ?? ""}`, Math.max(1, room), GLYPH.ellipsis);
}

/** Terminal rows under this are height class H1, where every tier keeps only the status line (4.2). */
const FOOTER_H1_ROWS = 20;
/** Measured cells under this are width class W1, where every tier keeps only the status line (4.2). */
const FOOTER_W1_CELLS = 44;
/** At or under this width the hint row offers no learning beside the keys that answer the moment. */
const FOOTER_NARROW_CELLS = 60;
/** The notice keeps at least this much of its row before the keys to read the rest ride beside it. */
const NOTICE_MIN_CELLS = 24;
/** A yolo window with less than this left is an alert on the notice row, whatever its meters say. */
const WINDOW_ENDING_MS = 5 * 60_000;

/**
 * The status line's reduction order (4.2), first to go first. Facts beyond the row's own (session name, memory,
 * skills, the weekly and yolo windows while neither is an alert, extension facts) go first. The cwd elides its leading
 * directories (`~/…/proj/x`), session cost goes, then the cwd shortens to its project and its basename, the target
 * goes, the queued count, the word `default`, the branch, the cwd and the workers count. Contained yolo then shortens
 * to `YOLO`. The mark and a non-default autonomy never drop. The model id never drops either; its form is chosen
 * before the fit (`footerStatusLine`). `default` goes before the branch because default autonomy is implied by its
 * absence, while the branch is a fact the row has nowhere else.
 */
const STATUS_RANK = {
	aux: 0,
	auxShort: 0.25,
	/** The yolo window's meters outlast the other extra facts: they bound what runs unattended. */
	windowDrop: 0.4,
	cwdElide: 0.5,
	cost: 1,
	cwdShort: 2,
	target: 3,
	queued: 4,
	autonomyWord: 5,
	branch: 6,
	cwd: 7,
	workers: 8,
	autonomyShort: 9,
	modelElide: 10,
} as const;
const MODEL_ID_MIN_CELLS = 12;

/**
 * The cwd from its fullest form to its basename. `fitPathLabel` cuts at directory boundaries; asking it for one cell
 * less than the last form yields the next `~/…/` form, kept while two directories remain (`~/…/proj/standard`). The
 * project with its parent (`proj/standard`) and the basename (`standard`) follow.
 */
function pathForms(path: string): string[] {
	const parts = path.split("/");
	const root = parts[0] === "~" ? "~/" : parts[0] === "" ? "/" : "";
	const segments = parts.slice(root === "" ? 0 : 1).filter((part) => part.length > 0);
	const lead = `${root}${GLYPH.ellipsis}/`;
	const forms = [path];
	for (let width = visibleWidth(path) - 1; width > 0; ) {
		const form = fitPathLabel(path, width);
		if (!form.includes("/") || visibleWidth(form) > width) break;
		if (form.startsWith(lead) && form.slice(lead.length).split("/").length >= 2) forms.push(form);
		width = visibleWidth(form) - 1;
	}
	if (segments.length >= 2) forms.push(segments.slice(-2).join("/"));
	const base = segments.at(-1);
	if (base !== undefined) forms.push(base);
	return [...new Set(forms)];
}

/**
 * The leading chips that fit `width` whole. A chip that does not fit is absent with every chip after it; none is cut
 * and nothing marks the cut, because a `…` at the row's end hid a fact behind a mark.
 */
function wholeChips(theme: ClioTheme, chips: ReadonlyArray<string | null>, width: number): string {
	const separator = theme.fg("separator", ` ${GLYPH.sep} `);
	let row = "";
	for (const chip of chips) {
		if (chip === null || chip.length === 0) continue;
		const next = row === "" ? chip : `${row}${separator}${chip}`;
		if (visibleWidth(next) > width) break;
		row = next;
	}
	return row;
}

const COMPACT_COUNT = /^(\d+(?:\.\d+)?)([kmgb]?)$/iu;
const COUNT_SCALE: Readonly<Record<string, number>> = { "": 1, k: 1e3, m: 1e6, g: 1e9, b: 1e9 };

/** A measured compact count back to its number; an estimate, a bound or an unknown is no figure to divide. */
function countValue(text: string): number | null {
	const match = COMPACT_COUNT.exec(text.replaceAll(",", ""));
	if (!match) return null;
	const scale = COUNT_SCALE[(match[2] ?? "").toLowerCase()];
	return scale === undefined ? null : Number(match[1]) * scale;
}

/** The newest main call's prompt read from cache, in whole percent, only when every part was measured. */
function cachePercent(cache: { read: string; write: string; uncached: string } | null): number | null {
	if (cache === null) return null;
	const read = countValue(cache.read);
	const write = countValue(cache.write);
	const uncached = countValue(cache.uncached);
	if (read === null || write === null || uncached === null) return null;
	const prompt = read + write + uncached;
	return prompt > 0 ? Math.round((read / prompt) * 100) : null;
}

/** `cache 87%`: the newest main call's prompt read from cache. */
function cacheShare(cache: { read: string; write: string; uncached: string } | null): string | null {
	const percent = cachePercent(cache);
	return percent === null ? null : `cache ${percent}%`;
}

/**
 * The newest rate the session can stand behind: the streaming turn's, else the newest settled main call's when it ran
 * on the session's route. A rate read back from a resumed session, or left by a route the session moved off, says
 * nothing about the next call (J1-F3); it stays on the dashboard labelled as the last call.
 */
function footerRate(state: FooterDashboardRenderState): { speed: string | null; ttft: string | null } {
	const newest = state.throughput ? null : state.telemetry.kind === "ready" ? state.telemetry.speed : null;
	const settled =
		newest !== null &&
		state.context.budget?.historical !== true &&
		newest.targetId === (state.session.targetId ?? newest.targetId) &&
		newest.modelId === (state.session.modelId ?? newest.modelId)
			? newest
			: null;
	const rate = state.throughput ? state.throughput.tokensPerSecond : settled?.tokensPerSecond;
	const estimated = state.throughput ? state.throughput.estimated === true : settled?.estimated === true;
	// A rate is live only while tokens are arriving; during a tool the turn's figure is as historical as a settled call's (HF03).
	const flowing = state.throughput !== null && (state.status.phase === "writing" || state.status.phase === "thinking");
	return {
		speed:
			typeof rate === "number" && Number.isFinite(rate) && rate > 0
				? `${flowing ? "" : "last "}${tokensPerSecondText(rate, estimated)} tok/s`
				: null,
		ttft: settled?.ttft ?? null,
	};
}

interface FooterCounts {
	workers: number;
	queued: number;
	plans: number;
}

/**
 * The status line: where on the left (the mark, autonomy, cwd, branch), what runs on the right (worker counts, session
 * cost, target, model id), fitted by {@link fitSides} so a unit drops or shortens whole and the model id never moves.
 */
function footerStatusLine(
	state: FooterDashboardRenderState,
	theme: ClioTheme,
	width: number,
	routeFacts: boolean,
	counts: FooterCounts,
	aux: ReadonlyArray<SideUnit>,
): string {
	const left: SideUnit[] = [{ text: GLYPH.brand, paint: () => brandMark(theme), lead: true }];
	const autonomy = state.session.autonomy ?? "default";
	/** Cells a non-default autonomy keeps at its shortest, with its space after the mark. */
	let autonomyFloor = 0;
	if (autonomy === "yolo") {
		const confinement = state.session.yoloConfinement === "unconfined" ? "unconfined" : "contained";
		const osSandbox = state.session.autonomyWindow?.osSandbox !== false;
		const wide = autonomyModeReadout({ confinement, osSandbox, narrow: false, dot: GLYPH.dot });
		const short = autonomyModeReadout({ confinement, osSandbox, narrow: true, dot: GLYPH.dot }).text;
		// Contained yolo ends as `YOLO`; an unconfined or unsandboxed session keeps the words that say so.
		const last = confinement === "contained" && osSandbox ? "YOLO" : short;
		const forms = [...new Set([short, last])].filter((form) => form !== wide.text);
		autonomyFloor = 1 + visibleWidth(last);
		left.push({
			text: wide.text,
			paint: (text) => theme.fg(wide.tone, text),
			shorter: forms.map((text) => ({ text, rank: STATUS_RANK.autonomyShort })),
		});
	} else {
		left.push({
			text: clean(autonomy),
			paint: (text) => theme.fg("annotation", text),
			// Default autonomy is implied by its absence; any other keeps its word.
			...(autonomy === "default" ? { drop: STATUS_RANK.autonomyWord } : {}),
		});
		if (autonomy !== "default") autonomyFloor = 1 + visibleWidth(clean(autonomy));
	}
	const paths = pathForms(clean(state.workspace.cwd));
	// Compact starts from the project and its parent; standard and up from the whole path.
	const cwdForms = routeFacts ? paths : paths.slice(Math.max(0, paths.length - 2));
	left.push({
		text: cwdForms[0] ?? clean(state.workspace.cwd),
		paint: (text) => theme.fg("workspacePath", text),
		// `~/…/` forms elide leading directories before the cost drops; the project and basename forms come after it.
		shorter: cwdForms.slice(1).map((text) => ({
			text,
			rank: text.includes(`${GLYPH.ellipsis}/`) ? STATUS_RANK.cwdElide : STATUS_RANK.cwdShort,
		})),
		drop: STATUS_RANK.cwd,
	});
	// Until the first probe lands the branch is unknown, not absent: say nothing. A detached HEAD is still a repository:
	// name the commit rather than claim there is no branch. A sentence is whole or absent (`no Gi…ranch`).
	const unnamed =
		state.workspace.detachedAt !== undefined ? `detached at ${state.workspace.detachedAt}` : "no Git branch";
	const branch = state.workspace.branchPending ? "" : clean(state.workspace.branch ?? unnamed);
	if (branch !== "") {
		// The dirty mark belongs to a named branch or commit, never to the sentence that says there is none.
		const dirty =
			state.workspace.dirty === true && (state.workspace.branch != null || state.workspace.detachedAt !== undefined);
		left.push({
			text: `${branch}${dirty ? "*" : ""}`,
			paint: (text) =>
				dirty ? `${theme.fg("branch", text.slice(0, -1))}${theme.fg("warning", "*")}` : theme.fg("branch", text),
			drop: STATUS_RANK.branch,
		});
	}

	const right: SideUnit[] = [...aux];
	const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
	if (counts.workers > 0)
		right.push({
			text: count(counts.workers, "worker", "workers"),
			paint: (text) => theme.fg("activity", text),
			drop: STATUS_RANK.workers,
		});
	if (counts.plans > 0)
		right.push({
			text: count(counts.plans, "plan", "plans"),
			paint: (text) => theme.fg("activity", text),
			drop: STATUS_RANK.workers,
		});
	if (routeFacts && counts.queued > 0)
		right.push({
			text: `${counts.queued} queued`,
			paint: (text) => theme.fg("annotation", text),
			drop: STATUS_RANK.queued,
		});
	const spend = state.telemetry;
	// The owner's display string, and only for an amount the session contributed: an unpriced route shows no unit.
	if (routeFacts && spend.kind === "ready" && spend.cost !== null && spend.cost !== COST_NOT_MEASURED)
		right.push({ text: clean(spend.cost), paint: (text) => theme.fg("counter", text), drop: STATUS_RANK.cost });
	const model = state.session.modelId ? clean(state.session.modelId) : null;
	if (routeFacts && model !== null && state.session.targetId)
		right.push({
			text: clean(state.session.targetId),
			paint: (text) => theme.fg("footerIdentity", text),
			drop: STATUS_RANK.target,
		});
	const identity = model ?? clean(state.session.target ?? "not configured");
	const leaf = identity.slice(identity.lastIndexOf("/") + 1);
	// The id's form is chosen against what never drops (the mark and a non-default autonomy): it loses its `provider/`
	// prefix, then its middle, only when those and the whole id do not fit, so a short row does not give up its
	// workspace first and then shorten the id anyway.
	const room = Math.max(MODEL_ID_MIN_CELLS, width - visibleWidth(GLYPH.brand) - autonomyFloor - 2);
	const prefixFree = visibleWidth(identity) > room && model !== null && leaf.length > 0 ? leaf : identity;
	const shown =
		visibleWidth(prefixFree) <= room
			? prefixFree
			: fitSides(theme, [], [{ text: prefixFree, elide: { rank: 0, min: MODEL_ID_MIN_CELLS } }], room).trim();
	right.push({
		text: shown,
		paint: (text) => theme.fg("activeModelIdentity", text),
		elide: { rank: STATUS_RANK.modelElide, min: MODEL_ID_MIN_CELLS },
	});
	return fitSides(theme, left, right, width);
}

/**
 * The detailed tier's second status row, chips that drop whole from the right: the session's tokens, its cost or
 * `cost not measured`, the last rate, the first-token time and the cache share.
 */
function footerSessionRow(
	state: FooterDashboardRenderState,
	theme: ClioTheme,
	width: number,
	rate: { speed: string | null; ttft: string | null },
): string {
	const spend = state.telemetry;
	const value = (text: string): string => theme.fg("counter", text);
	const label = (name: string, text: string): string => `${theme.fg("annotation", name)} ${value(text)}`;
	// The row's one focal value is the session's measured tokens; every other figure is body text.
	const tokens =
		spend.kind === "unavailable"
			? // Before the first turn the read model has no session view yet, which is no fault.
				value(state.agent.lastTurn === null ? "no calls yet" : "spend not available")
			: spend.kind === "reading"
				? value("reading the call journal")
				: spend.tokens === null
					? value("no calls yet")
					: spend.measuredTokens === null
						? theme.fg("unknownValue", "usage not measured")
						: metricText(theme, spend.measuredTokens, "tokens");
	const cost =
		spend.kind !== "ready" || spend.tokens === null
			? null
			: spend.cost === null || spend.cost === COST_NOT_MEASURED
				? theme.fg("unknownValue", "cost not measured")
				: value(clean(spend.cost));
	return wholeChips(
		theme,
		[
			`${theme.fg("annotation", "session")} ${tokens}`,
			cost,
			rate.speed === null ? null : value(rate.speed),
			rate.ttft === null ? null : label("first token", rate.ttft),
			spend.kind === "ready" ? (cacheShare(spend.promptCache) ?? null) : null,
			spend.kind === "ready" && spend.neverSent ? theme.fg("warning", spend.neverSent) : null,
		],
		width,
	);
}

type FooterAlertKind = "urgent" | "feedback" | "error" | "window" | "weekly" | "silence" | "warning" | "info";

interface FooterAlert {
	kind: FooterAlertKind;
	text: string;
	tone: ClioToken;
	glyph: string | null;
	/** The notice behind the alert, which the dismiss key clears; the other alerts end with their cause. */
	notice: boolean;
	/** The text continues past its first line, so the row names where the rest is. */
	more: boolean;
}

function noticeAlert(notice: Notification, kind: FooterAlertKind): FooterAlert {
	const [first = "", ...rest] = clean(notice.text).split("\n");
	return {
		kind,
		text: first,
		tone: notificationToken(notice.level),
		glyph: notificationGlyph(notice.level),
		notice: true,
		more: rest.length > 0,
	};
}

/** Newest first, the order a one-slot row reads a group in. */
function newestFirst(notices: ReadonlyArray<Notification>): Notification[] {
	return [...notices].sort((a, b) => b.addedAt - a.addedAt);
}

/** The yolo window and the weekly quota as the status line and the notice row both read them. */
interface FooterWindows {
	weekly: ReturnType<typeof routeWeeklyQuota> | null;
	readout: ReturnType<typeof autonomyWindowReadout> | null;
	/** The window ends soon or its meters warn: an alert on the notice row rather than a fact on the status line. */
	ending: boolean;
	nearest: ReturnType<typeof autonomyWindowReadout> | null;
}

function footerWindows(state: FooterDashboardRenderState, narrow: boolean): FooterWindows {
	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	const window = state.session.autonomy === "yolo" ? (state.session.autonomyWindow ?? null) : null;
	const readout =
		window === null ? null : autonomyWindowReadout(window, { narrow, dot: GLYPH.dot, resumeHint: "Enter continues" });
	const leftMs =
		window !== null && window.caps.minutes > 0 ? window.caps.minutes * 60_000 - window.usage.activeMs : null;
	return {
		weekly,
		readout,
		ending: readout !== null && (readout.tone === "warning" || (leftMs !== null && leftMs < WINDOW_ENDING_MS)),
		nearest: window === null ? null : autonomyWindowReadout(window, { narrow: true, dot: GLYPH.dot, resumeHint: "" }),
	};
}

/**
 * The live alerts, highest first (4.2): what the operator just asked for, an error, the alerts that state a standing
 * limit, then warnings, then information above the tier's floor. The notice row shows the first; the dashboard leads
 * with it at W1 and W2.
 */
function footerAlerts(
	state: FooterDashboardRenderState,
	w: number,
	policy: TierPolicy,
	keys: { surfaceOwnsKeys: boolean; immediateKeys: boolean; hintRow: boolean },
	windows: FooterWindows,
): { alerts: FooterAlert[]; feedback: ReturnType<typeof topNotification> } {
	const now = state.now;
	const feedback = topNotification(
		state.notices.filter((notice) => notice.presentation === "setting"),
		now,
	);
	const live = state.notices.filter(
		(entry) =>
			entry.presentation !== "setting" &&
			(entry.expiresAt === null || entry.expiresAt > now) &&
			// A tip teaches the idle composer; under a card, or while a run holds the keys, the row keeps what applies.
			!((keys.surfaceOwnsKeys || keys.immediateKeys) && entry.text.startsWith("tip: ")),
	);
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("clio-coder.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? typeof state.session.shutdownArmed === "string"
			? state.session.shutdownArmed
			: "Ctrl+C again to quit"
		: // The leader also opens the action menu, whose own rail lists the keys: a second legend under it said
			// `choose key` for a choice already on screen.
			state.session.leaderArmed && !keys.surfaceOwnsKeys
			? leaderKey
				? `${leaderKey} ${GLYPH.next} choose key`
				: "Choose key"
			: null;
	const silence = state.silenceNotes ?? null;
	const silenceNote = silence?.find((form) => visibleWidth(form) + 2 <= w) ?? silence?.at(-1) ?? null;
	const plain = (kind: FooterAlertKind, text: string, tone: ClioToken, glyph: string | null): FooterAlert => ({
		kind,
		text,
		tone,
		glyph,
		notice: false,
		more: false,
	});
	const { weekly, readout, ending } = windows;
	const alerts: FooterAlert[] = [
		...(urgent === null ? [] : [plain("urgent", urgent, "warning", null)]),
		// Setting feedback acknowledges a key the operator just pressed; with no hint row to carry it, it leads here.
		...(feedback && !keys.hintRow ? [plain("feedback", clean(feedback.text), "changedValue", null)] : []),
		...newestFirst(live.filter((entry) => entry.level === "error")).map((entry) => noticeAlert(entry, "error")),
		...(ending && readout ? [plain("window", readout.text, "warning", GLYPH.warn)] : []),
		...(weekly && weekly.severity === "critical" ? [plain("weekly", weekly.label, "error", GLYPH.warn)] : []),
		...(silenceNote === null ? [] : [plain("silence", silenceNote, "warning", GLYPH.warn)]),
		...newestFirst(live.filter((entry) => entry.level === "warning")).map((entry) => noticeAlert(entry, "warning")),
		...(policy.noticeFloor === "info"
			? newestFirst(live.filter((entry) => entry.level === "info" || entry.level === "success")).map((entry) =>
					noticeAlert(entry, "info"),
				)
			: []),
	];
	return { alerts, feedback };
}

/**
 * The notice row: the highest live alert at normal intensity with its glyph, then `+N <dashboard key>` for the rest
 * and the dismiss key at the right while a notice is among them.
 */
function renderAlertRow(
	theme: ClioTheme,
	alert: FooterAlert,
	others: number,
	dismissable: boolean,
	width: number,
	dashboardKey: string,
	dismissKeyLabel: string | undefined,
): string {
	const body = alert.glyph === null ? alert.text : `${alert.glyph} ${alert.text}`;
	const cut = alert.more || visibleWidth(body) > width;
	const dismiss =
		dismissable && dismissKeyLabel && !dismissKeyLabel.startsWith("unbound")
			? (dismissKeyLabel.split(` ${GLYPH.dot} `).at(-1) ?? "")
			: "";
	const more = others > 0 ? `+${others} ${dashboardKey}` : cut ? dashboardKey : "";
	const keys = [more, dismiss].filter(Boolean).join(` ${GLYPH.sep} `);
	const keyText = keys ? theme.fg("keyboardHint", keys) : "";
	const painted = (cells: number): string => theme.fg(alert.tone, fitNoticeWords(body, cells));
	// A narrow row keeps the alert itself; the keys ride along only while it keeps enough room to read.
	if (!keyText || width - visibleWidth(keyText) - 2 < NOTICE_MIN_CELLS) return painted(width);
	const room = width - visibleWidth(keyText) - 2;
	const shown = painted(room);
	return `${shown}${" ".repeat(Math.max(2, width - visibleWidth(shown) - visibleWidth(keyText)))}${keyText}`;
}

/**
 * The footer (4.2): the status line; at detailed the session row; the notice row while an alert is live; at standard
 * and up the hint row. Its height is fixed per tier so the composer does not move: 1, 2 or 3 rows, and a notice adds
 * one. A W1 width, an H1 terminal and a surface that owns the keys reduce every tier to the status line, plus the
 * notice row only for an armed quit or an error.
 */
export function renderCompactDashboard(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	// The tiers that keep a hint row are the ones that name the route, the session cost and the full path (3.2).
	const routeFacts = policy.hintRow;
	const keyContext = state.keyContext ?? "send";
	const surfaceOwnsKeys = keyContext === "surface";
	// The keys that answer this moment, which a tip must not cover.
	const immediateKeys = keyContext !== "surface" && keyContext !== "idle" && keyContext !== "send";
	const reduced = w < FOOTER_W1_CELLS || terminalRows < FOOTER_H1_ROWS || surfaceOwnsKeys;
	const narrow = w <= FOOTER_NARROW_CELLS;
	const now = state.now;

	const liveWorkers = workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const queued = liveWorkers.filter((row) => row.status === "enqueued").length;
	const counts: FooterCounts = {
		workers: liveWorkers.length - queued,
		queued,
		plans: state.dispatchRows.filter((row) => row.plan !== undefined && row.status === "running").length,
	};
	const windows = footerWindows(state, narrow);
	const { weekly, readout: windowReadout, ending: windowEnding, nearest } = windows;
	// Idle and off say nothing: memory is named only while it works or cannot. The rail names a memory call from its
	// first moment, and memory yields the model to the turn on purpose, so its wait is no fault (N9).
	const guardian = state.session.memoryIntervention?.guardian;
	const memoryOnRail = (state.background ?? []).some((call) => call.purpose === "memory review");
	const skills = state.session.activeSkills ?? [];
	const styled = (text: string): SideUnit => ({ text, drop: STATUS_RANK.aux });
	// Facts the row carries beside its own while they fit: an alert of the same kind has the notice row instead.
	const aux: SideUnit[] = [
		...(routeFacts && state.session.name
			? [
					{
						text: clean(state.session.name),
						paint: (text: string) => theme.fg("footerIdentity", text),
						drop: STATUS_RANK.aux,
					},
				]
			: []),
		...(guardian === "reviewing" && !memoryOnRail ? [styled(theme.fg("activity", "memory reviewing"))] : []),
		...(guardian === "unavailable" ? [styled(theme.fg("unknownValue", "memory review paused"))] : []),
		...(skills.length
			? [
					styled(
						`${theme.fg("skillAction", "skill ")}${theme.fg("counter", fitNames("", skills.map(clean), Math.max(8, Math.floor(w / 3))))}`,
					),
				]
			: []),
		...(routeFacts && windowReadout !== null && !windowEnding
			? [
					{
						text: windowReadout.text,
						paint: (text: string) => theme.fg("counter", text),
						...(nearest !== null && nearest.text !== windowReadout.text
							? { shorter: [{ text: nearest.text, rank: STATUS_RANK.auxShort }] }
							: {}),
						drop: STATUS_RANK.windowDrop,
					},
				]
			: []),
		...(weekly && weekly.severity !== "critical" && (routeFacts || weekly.severity !== "normal")
			? [styled(theme.fg(weekly.severity === "normal" ? "counter" : "warning", weekly.label))]
			: []),
		...(state.extensionFacts ?? []).map(styled),
	];
	const rows = [footerStatusLine(state, theme, w, routeFacts, counts, aux)];

	const rate = footerRate(state);
	if (policy.statusRows >= 2 && !reduced) rows.push(footerSessionRow(state, theme, w, rate));

	const hintRow = policy.hintRow && !reduced;
	const { alerts, feedback } = footerAlerts(state, w, policy, { surfaceOwnsKeys, immediateKeys, hintRow }, windows);
	const top = alerts[0];
	const shownAlert = top === undefined ? null : !reduced || top.kind === "urgent" || top.kind === "error" ? top : null;
	if (shownAlert !== null)
		rows.push(
			renderAlertRow(
				theme,
				shownAlert,
				alerts.length - 1,
				alerts.some((alert) => alert.notice),
				w,
				actionKeyLabel("clio-coder.status.toggle") ?? "Dashboard",
				state.dismissKeyLabel,
			),
		);
	if (!hintRow) return rows;

	const learning = policy.tips && state.demo !== false;
	const controls = feedback
		? theme.fg("changedValue", fitNoticeWords(clean(feedback.text), w))
		: learning && state.demoHint && !immediateKeys && shownAlert === null
			? `${theme.fg("guidance", "Tip")} ${theme.fg("counter", fitNoticeWords(clean(state.demoHint), Math.max(1, w - 4)))}`
			: state.welcomeVisible
				? ""
				: theme.fg("keyboardHint", footerKeyHint(now, narrow, w, keyContext, { ...state.keyHintFacts, learning }) ?? "");
	rows.push(controls);
	return rows;
}

/**
 * A notice cut to its row at a word boundary: `the whole prompt is r…` left a fragment where the next word was. A
 * cut that would lose more than a third of the row to reach a space keeps the plain cut.
 */
function fitNoticeWords(text: string, width: number): string {
	const room = Math.max(1, width);
	if (visibleWidth(text) <= room) return text;
	const cut = truncateToWidth(text, room, "", false);
	const space = cut.lastIndexOf(" ");
	const whole = space >= Math.ceil(room * 0.66) ? cut.slice(0, space).replace(/[\s·:;,]+$/u, "") : null;
	return whole === null ? truncateToWidth(text, room, GLYPH.ellipsis, false) : `${whole}${GLYPH.ellipsis}`;
}

/** The dashboard's label column: its widest labels (`session`, `context`, `notices`) take seven cells. */
const DASH_LABEL_CELLS = 7;
/** Cells between two dashboard columns. */
const DASH_GAP = 2;
/** A block column other than the last is at most this wide (4.3: 42 cells at 80 and at 120 columns). */
const DASH_COLUMN_CELLS = 42;
/** The last block keeps at least this much, which holds a run row with its elapsed time. */
const DASH_LAST_COLUMN_CELLS = 30;
/** Task text narrower than this beside a fact is left out rather than shown as a stub and `…`. */
const DASH_TASK_MIN_CELLS = 8;
/** The context meter inside its fact: twelve cells at every width, the figure beside it says the rest. */
const DASH_METER_CELLS = 12;
/** The route in the title rule keeps at least this much, or the title rule names no route. */
const DASH_ROUTE_MIN_CELLS = 12;

type DashKey =
	| "turn"
	| "tokens"
	| "cache"
	| "think"
	| "speed"
	| "tools"
	| "fleet"
	| "runs"
	| "session"
	| "cost"
	| "context"
	| "limit"
	| "tasks"
	| "notices"
	| "cacheShare"
	| "slots";

/**
 * The blocks as columns (4.3), one layout per row budget of the tier: two columns from W3 (turn, then session, the
 * fleet as one fact closing the turn column), three from W4 (turn, session, fleet with its run rows).
 */
const DASH_LAYOUTS: ReadonlyArray<{ rows: number; two: DashKey[][]; three: DashKey[][] }> = [
	{
		rows: 2,
		two: [
			["turn", "fleet"],
			["session", "context"],
		],
		three: [
			["turn", "speed"],
			["session", "context"],
			["fleet", "tasks"],
		],
	},
	{
		rows: 4,
		two: [
			["turn", "tokens", "speed", "fleet"],
			["session", "context", "limit", "tasks"],
		],
		three: [
			["turn", "tokens", "speed", "tools"],
			["session", "context", "limit", "tasks"],
			["fleet", "runs"],
		],
	},
	{
		rows: 6,
		two: [
			["turn", "tokens", "cache", "think", "speed", "fleet"],
			["session", "cost", "context", "limit", "tasks", "notices"],
		],
		three: [
			["turn", "tokens", "cache", "think", "speed", "tools"],
			["session", "cost", "context", "limit", "cacheShare", "notices"],
			["fleet", "runs", "tasks", "slots"],
		],
	},
];

interface DashFact {
	label: string;
	/** Whole chips, dropped from the right when the row is short; a fact whose first chip does not fit is absent. */
	chips?: ReadonlyArray<string | null>;
	/** The value fitted to `room` cells by the fact itself; empty when nothing fits. */
	fit?: (room: number) => string;
	/** Task text after the chips: the one part of a fact row that may close on `…`. */
	task?: string;
}

interface DashContext {
	state: FooterDashboardRenderState;
	theme: ClioTheme;
	/** The tier's row budget, which also says how much evidence a fact carries (2 is outcomes only). */
	budget: number;
	/** This visit's worker runs, worst first. */
	runs: RunFacts[];
	boardKey: string;
	/** The layout has a cost fact of its own, so the session fact leaves the cost to it. */
	costRow: boolean;
}

/** A dispatch board row as run facts: outcome, validation and integrity, so the run row model picks the state. */
function dashRunFacts(row: DispatchBoardRow): RunFacts {
	const origin: RunOrigin =
		row.requestOrigin === "user" ? "operator" : row.requestOrigin === "harness" ? "harness" : "model";
	const base = {
		agent: clean(row.agentId),
		origin,
		...(row.agentAudience === "shadow" || row.agentAudience === "internal" ? { helper: true } : {}),
		runId: row.runId,
		elapsed: formatElapsed(row.elapsedMs),
		...(row.taskSummary ? { task: clean(row.taskSummary) } : {}),
	};
	// The cause in the run's own words, without the worker's stderr dump.
	const cause = row.outcomeDetail
		? (clean(row.outcomeDetail)
				.split(/;\s*stderr:/u)[0]
				?.trim() ?? "")
		: "";
	switch (row.status) {
		case "enqueued":
			return { ...base, outcome: "queued", phase: "no free slot" };
		case "running":
			return { ...base, outcome: "running", ...(row.currentTool ? { phase: clean(row.currentTool) } : {}) };
		case "retrying":
			return { ...base, outcome: "running", phase: "retrying" };
		case "cancelling":
			return { ...base, outcome: "running", phase: "stopping" };
		case "stale":
			return { ...base, outcome: "running", phase: "quiet" };
		case "aborted":
			return {
				...base,
				outcome: "cancelled",
				...(cause && !/^operator abort\b/u.test(cause) ? { reason: cause } : {}),
			};
		case "completed": {
			const integrity = row.trust?.axes.artifactIntegrity;
			const rejected = row.hostVerification === "rejected";
			return {
				...base,
				outcome: "succeeded",
				validation: rejected ? "failed" : row.hostVerification === "verified" ? "passed" : "none",
				integrity: integrity === "verified" ? "verified" : integrity === "failed" ? "compromised" : "unverified",
				...(rejected && row.validationFailure ? { reason: clean(row.validationFailure) } : {}),
			};
		}
		default:
			return { ...base, outcome: "failed", reason: cause || clean(row.validationFailure ?? row.status) };
	}
}

/** Paint run-row cells: each cell's lead, then its glyph and text in its role. */
function paintRunCells(theme: ClioTheme, cells: readonly RunCell[]): string {
	let out = "";
	for (const cell of cells) {
		const text = `${cell.glyph === undefined ? "" : GLYPH[cell.glyph]}${cell.text}`;
		out += `${cell.lead}${text.length === 0 ? "" : theme.fg(cell.role, text)}`;
	}
	return out;
}

/** `17 tools, 2 failed`, the failure count in the error role; nothing when the turn called no tool. */
function turnToolWords(theme: ClioTheme, lastTurn: NonNullable<FooterDashboardRenderState["agent"]["lastTurn"]>) {
	if (lastTurn.toolCount <= 0) return null;
	const tools = theme.fg("counter", `${lastTurn.toolCount} tool${lastTurn.toolCount === 1 ? "" : "s"}`);
	return lastTurn.toolErrorCount > 0 ? `${tools}${theme.fg("error", `, ${lastTurn.toolErrorCount} failed`)}` : tools;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** One fact of the dashboard, or null when the session has nothing to say for it. */
function dashFact(key: DashKey, ctx: DashContext, form: { list: boolean; runRows: boolean }): DashFact | null {
	const { state, theme } = ctx;
	const value = (text: string): string => theme.fg("counter", text);
	const unknown = (text: string): string => theme.fg("unknownValue", text);
	const note = (text: string): string => theme.fg("annotation", text);
	const spend = state.telemetry;
	const turn = spend.kind === "ready" ? spend.turn : null;
	const evidence = ctx.budget > 2;
	switch (key) {
		case "turn": {
			const rate = footerRate(state);
			const speed = rate.speed === null ? null : value(rate.speed);
			const live = (state.status.phase !== "idle" && state.status.phase !== "ended") || (state.toolCounts.active ?? 0) > 0;
			if (live)
				return {
					label: "turn",
					chips: [buildHarnessStatePill(theme, state.status, state.toolCounts, state.tick, state.now, 40), speed],
				};
			const last = state.agent.lastTurn;
			if (last === null) return { label: "turn", chips: [value("no turn yet")] };
			return {
				label: "turn",
				chips: [lastTurnOutcome(theme, last), turnToolWords(theme, last), form.list ? speed : null],
			};
		}
		case "speed": {
			const rate = footerRate(state);
			if (rate.speed === null && rate.ttft === null) return null;
			return {
				label: "speed",
				chips: [
					rate.speed === null ? null : value(rate.speed),
					evidence && rate.ttft !== null ? `${note("first token")} ${value(rate.ttft)}` : null,
				],
			};
		}
		case "tokens": {
			if (turn === null) return null;
			const cached = turn.cacheRead === null || turn.cacheRead === "0" || turn.cacheRead === "?" ? null : turn.cacheRead;
			const chips = [
				turn.input === null ? null : value(`in ${turn.input}`),
				turn.output === null ? null : value(`out ${turn.output}`),
				cached === null ? null : value(`cached ${cached}`),
			];
			return chips.some((chip) => chip !== null) ? { label: "tokens", chips } : null;
		}
		case "cache": {
			if (turn === null) return null;
			const chips = [
				turn.cacheRead === null || turn.cacheRead === "0"
					? null
					: turn.cacheRead === "?"
						? unknown("read not reported")
						: value(`read ${turn.cacheRead}`),
				turn.cacheWrite === null || turn.cacheWrite === "0" ? null : value(`write ${turn.cacheWrite}`),
			];
			return chips.some((chip) => chip !== null) ? { label: "cache", chips } : null;
		}
		case "think": {
			const reasoning = turn?.reasoning;
			if (!reasoning || formatReasoningChip(reasoning) === null) return null;
			const mark = reasoning.provenance === "provider" ? "" : GLYPH.estimate;
			return { label: "think", chips: [value(`${mark}${formatFooterTokens(reasoning.tokens)} reasoning tokens`)] };
		}
		case "tools": {
			const entries = Object.entries(state.toolCounts.tools)
				.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([name, count]) => value(`${clean(name)} ${formatFooterTokens(count)}`));
			if (entries.length === 0) return null;
			const separator = theme.fg("separator", ` ${GLYPH.sep} `);
			return {
				label: "tools",
				fit: (room) => {
					for (let kept = entries.length; kept > 0; kept -= 1) {
						const parts = entries.slice(0, kept);
						if (kept < entries.length) parts.push(value(`+${entries.length - kept}`));
						const row = parts.join(separator);
						if (visibleWidth(row) <= room) return row;
					}
					return "";
				},
			};
		}
		case "fleet": {
			if (ctx.runs.length === 0)
				return { label: "fleet", chips: [value("no workers"), evidence ? note("/run starts one") : null] };
			const buckets = runCountBuckets(ctx.runs);
			const key = form.runRows ? "" : theme.fg("keyboardHint", ctx.boardKey);
			const separator = theme.fg("separator", ` ${GLYPH.sep} `);
			return {
				label: "fleet",
				fit: (room) => {
					if (key !== "") {
						const counts = runCountRow(buckets, room - visibleWidth(key) - visibleWidth(separator));
						if (counts.length > 0) return `${paintRunCells(theme, counts)}${separator}${key}`;
					}
					return paintRunCells(theme, runCountRow(buckets, room));
				},
			};
		}
		case "session": {
			if (spend.kind === "unavailable") return { label: "session", chips: [unknown("not available")] };
			if (spend.kind === "reading") return { label: "session", chips: [unknown("reading the call journal")] };
			const tokens =
				spend.tokens === null && spend.neverSent === null
					? value("no calls yet")
					: spend.tokens !== null && spend.measuredTokens === null
						? unknown("usage not measured")
						: value(`${spend.tokens === null ? "0" : spend.measuredTokens} tokens`);
			const cost =
				ctx.costRow && !form.list
					? null
					: spend.cost === null
						? null
						: spend.cost === COST_NOT_MEASURED
							? unknown("cost not measured")
							: value(clean(spend.cost));
			return {
				label: "session",
				// The cost is the session's second fact; calls that never reached a provider yield first on a short row.
				chips: [tokens, cost, spend.neverSent ? theme.fg("warning", spend.neverSent) : null],
			};
		}
		case "cost": {
			if (spend.kind !== "ready") return null;
			const receipt = receiptChips(theme, state);
			if (receipt.length > 0) return { label: "cost", chips: receipt };
			if (spend.cost === null) return null;
			return {
				label: "cost",
				chips: [spend.cost === COST_NOT_MEASURED ? unknown("not measured") : value(clean(spend.cost))],
			};
		}
		case "cacheShare": {
			const percent = spend.kind === "ready" ? cachePercent(spend.promptCache) : null;
			return percent === null ? null : { label: "cache", chips: [value(`${percent}% of prompt read from cache`)] };
		}
		case "context": {
			const facts = state.context;
			const ledger = facts.ledger ?? null;
			const used = facts.budget ? facts.used : (ledger?.usedTokens ?? facts.used);
			const window = facts.budget ? facts.contextWindow : (ledger?.contextWindow ?? facts.contextWindow);
			if (!window) return { label: "context", chips: [unknown("window unknown")] };
			const qualifier = contextReadingQualifier({ ...(facts.budget ? { budget: facts.budget } : {}), used });
			const source: FillSource = qualifier === "" ? "measured" : qualifier === GLYPH.estimate ? "estimated" : "saved";
			const percent = used === null ? null : (used / window) * 100;
			const fill = theme.fg(percent === null ? "counter" : contextPercentRole(percent), formatFill(used, window, source));
			const bar = ledger ? renderContextMeterBar(ledger, DASH_METER_CELLS, theme) : "";
			return {
				label: "context",
				fit: (room) => {
					const full = bar === "" ? fill : `${bar} ${fill}`;
					if (visibleWidth(full) <= room) return full;
					return visibleWidth(fill) <= room ? fill : "";
				},
			};
		}
		case "limit": {
			const ceiling = state.costCeilingUsd;
			return {
				label: "limit",
				chips:
					ceiling === undefined
						? [unknown("unknown")]
						: ceiling === 0
							? [value("none")]
							: [value(renderUsdLimit(ceiling)), note("tracked pricing only")],
			};
		}
		case "tasks": {
			const board = state.agent.taskBoard;
			if (!board || board.tasks.length === 0) return { label: "tasks", chips: [value("none")] };
			const active = evidence ? board.tasks.find((task) => task.status === "active") : undefined;
			return {
				label: "tasks",
				chips: [taskBoardValue(theme, board)],
				...(active ? { task: `${clean(active.id)} ${clean(active.title)}` } : {}),
			};
		}
		case "notices": {
			const live = state.notices.filter(
				(notice) => notice.presentation !== "setting" && (notice.expiresAt === null || notice.expiresAt > state.now),
			);
			const count = (levels: ReadonlyArray<Notification["level"]>): number =>
				live.filter((notice) => levels.includes(notice.level)).length;
			const errors = count(["error"]);
			const warnings = count(["warning"]);
			const infos = count(["info", "success"]);
			const chips = [
				errors > 0 ? theme.fg("error", plural(errors, "error")) : null,
				warnings > 0 ? theme.fg("warning", plural(warnings, "warning")) : null,
				infos > 0 ? value(`${infos} info`) : null,
			];
			return { label: "notices", chips: chips.some((chip) => chip !== null) ? chips : [value("none")] };
		}
		case "slots": {
			const live = workerRowsOf(state.dispatchRows).filter(
				(row) => ACTIVE_DISPATCH_STATUSES.has(row.status) && row.status !== "enqueued",
			);
			const capacity = state.agent.localCapacity;
			if (capacity)
				return {
					label: "slots",
					chips: [
						value(`${live.length}/${capacity.limit}`),
						// The auto maximum's bound is named "cap"; `cap 8 · cap` read as a row cut mid-word.
						note(capacity.bound === "cap" ? "built-in max" : clean(capacity.bound)),
					],
				};
			const endpoint = live.find((row) => row.endpoint !== undefined)?.endpoint;
			if (!endpoint) return null;
			const busy = live.filter((row) => row.endpoint?.key === endpoint.key).length;
			return { label: "slots", chips: [value(`${busy}/${endpoint.limit} ${clean(endpoint.label)}`)] };
		}
		case "runs":
			return null;
	}
}

/**
 * One fact row: the label column, then the value. Chips drop whole from the right and a fact whose first chip does
 * not fit is absent (null); only task text may close on `…`.
 */
function dashRow(theme: ClioTheme, fact: DashFact | null, width: number): string | null {
	if (fact === null) return null;
	const room = width - DASH_LABEL_CELLS - 2;
	if (room < 1) return null;
	let body = fact.fit ? fact.fit(room) : wholeChips(theme, fact.chips ?? [], room);
	if (fact.task !== undefined && fact.task.length > 0) {
		const separator = body === "" ? "" : theme.fg("separator", ` ${GLYPH.sep} `);
		const left = room - visibleWidth(body) - visibleWidth(separator);
		if (left >= Math.min(DASH_TASK_MIN_CELLS, visibleWidth(fact.task)))
			body = `${body}${separator}${theme.fg("body", truncateToWidth(fact.task, left, GLYPH.ellipsis, false))}`;
	}
	return body === "" ? null : `${padAnsi(theme.fg("annotation", fact.label), DASH_LABEL_CELLS)}  ${body}`;
}

/** Up to `count` run rows in the section 6.1 grammar, worst first, sharing one identity column. */
function dashRunRows(ctx: DashContext, count: number, width: number): string[] {
	const runs = ctx.runs.slice(0, Math.max(0, count));
	const identityWidth = runIdentityWidth(runs, visibleWidth);
	return runs.map((facts) =>
		paintRunCells(ctx.theme, runRow(facts, { width, identityWidth, measure: visibleWidth, rail: false }).cells),
	);
}

/** One column of facts, exactly `rows` rows; an absent fact leaves its row blank so the column keeps its shape. */
function dashColumn(ctx: DashContext, keys: readonly DashKey[], rows: number, width: number): string[] {
	const runRows = keys.includes("runs");
	const others = keys.filter((key) => key !== "runs").length;
	const lines: string[] = [];
	for (const key of keys) {
		if (key === "runs") lines.push(...dashRunRows(ctx, rows - others, width));
		else lines.push(dashRow(ctx.theme, dashFact(key, ctx, { list: false, runRows }), width) ?? "");
	}
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

/**
 * The blocks side by side. Each column but the last takes its widest row, at most {@link DASH_COLUMN_CELLS} and never
 * so much that a later block gets under {@link DASH_LAST_COLUMN_CELLS}, so the last block gets the room left.
 */
function dashColumns(ctx: DashContext, layout: readonly DashKey[][], rows: number, width: number): string[] {
	const columns: string[][] = [];
	const widths: number[] = [];
	let used = 0;
	layout.forEach((keys, index) => {
		const left = layout.length - index;
		const available = width - used;
		const share =
			left === 1
				? available
				: Math.min(
						DASH_COLUMN_CELLS,
						Math.max(
							Math.floor((available - DASH_GAP * (left - 1)) / left),
							available - (DASH_GAP + DASH_LAST_COLUMN_CELLS) * (left - 1),
						),
					);
		const lines = dashColumn(ctx, keys, rows, Math.max(1, share));
		const cells = left === 1 ? share : Math.max(1, ...lines.map((line) => visibleWidth(line)));
		columns.push(lines);
		widths.push(cells);
		used += cells + DASH_GAP;
	});
	return Array.from({ length: rows }, (_, row) =>
		columns
			.map((lines, index) =>
				index === columns.length - 1 ? (lines[row] ?? "") : padAnsi(lines[row] ?? "", (widths[index] ?? 1) + DASH_GAP),
			)
			.join(""),
	);
}

/**
 * W1 and W2: no columns, a priority list of one-row summaries. The live alert leads, then the turn, the fleet while
 * a run is live or failed, the session and the context; what does not fit is one command away on the closing rule.
 */
function dashList(ctx: DashContext, rows: number, width: number, alert: string | null): string[] {
	const buckets = runCountBuckets(ctx.runs);
	const fleetLive = buckets.failed + buckets.waiting + buckets.running + buckets.queued > 0;
	const keys: DashKey[] = ["turn", ...(fleetLive ? (["fleet"] as const) : []), "session", "context"];
	const lines = alert === null ? [] : [alert];
	for (const key of keys) {
		const row = dashRow(ctx.theme, dashFact(key, ctx, { list: true, runRows: false }), width);
		if (row !== null) lines.push(row);
	}
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

/** `Dashboard ──── <build> · <route> ─`: the build gives way first, then the route shortens keeping its suffix. */
function dashTitle(theme: ClioTheme, state: FooterDashboardRenderState, withBuild: boolean, width: number): string {
	const route = `${state.session.duckBadge ? "🦆 " : ""}${clean(state.session.target ?? "No model selected")}`;
	const separator = ` ${GLYPH.sep} `;
	// The label and its space, ` <meta> ─` and two cells of fill.
	const room = width - visibleWidth("Dashboard ") - 3 - 2;
	const build = withBuild ? clioBuildLabel() : "";
	const buildCells = visibleWidth(build) + visibleWidth(separator);
	const meta =
		build !== "" && buildCells + Math.min(visibleWidth(route), DASH_ROUTE_MIN_CELLS) <= room
			? `${theme.fg("annotation", build)}${theme.fg("separator", separator)}${theme.fg("footerIdentity", fitIdentityLabel(route, room - buildCells))}`
			: room >= DASH_ROUTE_MIN_CELLS
				? theme.fg("footerIdentity", fitIdentityLabel(route, room))
				: "";
	return rule(theme, width, {
		left: "Dashboard",
		...(meta === "" ? {} : { right: meta, rightRaw: true, rightTail: theme.fg("divider", GLYPH.rule) }),
	});
}

/** `──── [Alt+U] close · /usage · /context · /fleet ─`; a narrow row keeps the commands, which name every cut block. */
function dashClose(theme: ClioTheme, toggleKey: string, width: number): string {
	const separator = theme.fg("separator", ` ${GLYPH.sep} `);
	const where = ["/usage", "/context", "/fleet"].map((command) => theme.fg("keyboardHint", command)).join(separator);
	const cap = toggleKey ? keyCap(theme, toggleKey, "keyboardHint") : "";
	const forms = cap
		? [`${cap} ${theme.fg("keyboardHint", "close")}${separator}${where}`, `${cap}${separator}${where}`, where]
		: [where];
	// The key goes last: a form that keeps it bare beats a ruled form without it.
	for (const form of forms) {
		if (visibleWidth(form) + 5 <= width)
			return rule(theme, width, { right: form, rightRaw: true, rightTail: theme.fg("divider", GLYPH.rule) });
		if (visibleWidth(form) <= width) return form;
	}
	return truncateToWidth(where, width, GLYPH.ellipsis, true);
}

/**
 * The Alt+U dashboard (4.3): a glance panel of fixed height that never scrolls. A titled light rule, the tier's
 * `dashboardRows` content rows (reduced so the panel fits a third of the terminal), and a closing rule naming where
 * the rest lives. The footer's status line stays under it.
 */
export function dashboardPageViewport(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows: number,
	toggleKey: string,
): string[] {
	const theme = clioTheme();
	const w = Math.max(1, Math.floor(width));
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	const height = Math.max(3, Math.min(policy.dashboardRows + 2, Math.floor(terminalRows / 3)));
	const rows = height - 2;
	const layouts = DASH_LAYOUTS.filter((layout) => layout.rows <= policy.dashboardRows).at(-1) ?? DASH_LAYOUTS[0];
	const kind = widthClass(w);
	const layout = kind === "W3" ? layouts?.two : layouts?.three;
	const ctx: DashContext = {
		state,
		theme,
		budget: policy.dashboardRows,
		runs: workerRowsOf(state.dispatchRows)
			.filter((row) => row.earlier !== true)
			.map(dashRunFacts)
			.sort(compareRuns),
		boardKey: actionKeyLabel("clio-coder.dispatchBoard.toggle") ?? "/fleet",
		costRow: layout?.some((keys) => keys.includes("cost")) === true,
	};
	let body: string[];
	if (kind === "W1" || kind === "W2" || layout === undefined) {
		const { alerts } = footerAlerts(
			state,
			w,
			policy,
			{ surfaceOwnsKeys: false, immediateKeys: false, hintRow: policy.hintRow },
			footerWindows(state, w <= FOOTER_NARROW_CELLS),
		);
		const top = alerts[0];
		const alert =
			top === undefined
				? null
				: theme.fg(top.tone, fitNoticeWords(top.glyph === null ? top.text : `${top.glyph} ${top.text}`, w));
		body = dashList(ctx, rows, w, alert);
	} else body = dashColumns(ctx, layout, rows, w);
	return [dashTitle(theme, state, policy.hintRow, w), ...body, dashClose(theme, toggleKey, w)];
}
