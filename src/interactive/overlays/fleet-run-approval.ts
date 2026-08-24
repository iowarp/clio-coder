/**
 * `/fleet run <name>` approval: the whole plan, before anything dispatches.
 *
 * The operator reads the compiled plan here and decides. Enter accepts and the
 * run starts; Esc cancels and nothing is dispatched, nothing is written, and no
 * ledger row exists. A contract that failed preflight opens the same overlay
 * with its diagnostics and no accept key, so the only way out of a broken plan
 * is to leave it.
 *
 * The body is a pure function of the projection so the layout is testable
 * without a TUI.
 */

import { type Component, type OverlayHandle, type TUI, truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { FleetRunPreview, FleetRunPreviewStep } from "../fleet-run-preview.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";

export const FLEET_RUN_APPROVAL_OVERLAY_TITLE = "Fleet run approval";

const FLEET_RUN_APPROVAL_MIN_WIDTH = 48;
const FLEET_RUN_APPROVAL_MAX_WIDTH = 110;
/** Rows of plan shown at once. Anything longer scrolls. */
export const FLEET_RUN_APPROVAL_VISIBLE_ROWS = 22;

function fleetRunApprovalOverlayWidth(columns: number): number {
	return Math.max(FLEET_RUN_APPROVAL_MIN_WIDTH, Math.min(FLEET_RUN_APPROVAL_MAX_WIDTH, columns - 4));
}

/** What the overlay renders: an accepted-shaped plan or the reasons there is none. */
export type FleetRunApprovalSubject =
	| { ok: true; preview: FleetRunPreview }
	| { ok: false; name: string; diagnostics: ReadonlyArray<string> };

export interface OpenFleetRunApprovalOverlayOptions {
	subject: FleetRunApprovalSubject;
	/** Live terminal width, so the box tracks the window it opened in. */
	columns: number;
	/** Enter: dispatch this exact plan. Never called for a failed preflight. */
	onAccept: () => void;
	/** Esc: nothing is dispatched and nothing is written. */
	onCancel: () => void;
}

/** The declared boundary as one phrase: an empty allowlist is a claim, not an absence. */
export function formatWriteBoundary(writes: ReadonlyArray<string> | undefined): string {
	if (writes === undefined) return "writes unenforced";
	if (writes.length === 0) return "writes nothing";
	return `writes ${writes.join(", ")}`;
}

/** One step as its facts: kind, who runs it, where, its scope, and its boundary. */
export function formatFleetRunPreviewStep(step: FleetRunPreviewStep): string {
	const loop = step.loop === undefined ? "" : ` (${step.loop.loopId} ${step.loop.role} ${step.loop.attempt})`;
	if (step.kind === "code") {
		const gate = step.gate === undefined ? "" : ` · gate path ${step.gate.path}`;
		return `code ${step.stepId}${loop} · command ${step.commandId ?? "?"}${gate} · ${step.scope} · ${formatWriteBoundary(step.writes)}`;
	}
	const route = step.route === undefined ? "route unresolved" : `${step.route.targetId} ▸ ${step.route.wireModelId}`;
	const node = step.route === undefined ? "" : ` · node ${step.route.nodeId}`;
	const declaredRoute =
		step.target !== undefined
			? ` · target ${step.target}`
			: step.profile !== undefined
				? ` · profile ${step.profile}`
				: "";
	const gate =
		step.gate !== undefined
			? ` · gate path ${step.gate.path} · run ${"commandId" in step.gate ? step.gate.commandId : "?"} · baseline ${"commandId" in step.gate ? step.gate.commandId : "?"}`
			: "";
	const dynamicPlan =
		step.plan === undefined
			? ""
			: ` · roster ${step.plan.roster.join(", ")} · maxTasks ${step.plan.maxTasks}${step.plan.proposals ? " · proposals" : ""}`;
	return `agent ${step.stepId}${loop} · ${step.agentId ?? "?"} · ${route}${node}${declaredRoute}${gate}${dynamicPlan} · ${step.scope} · ${formatWriteBoundary(step.writes)}`;
}

function formatBudgetLine(preview: FleetRunPreview): string {
	const contract =
		preview.budget.contractUsd === null
			? "contract declares no ceiling"
			: `contract ceiling $${preview.budget.contractUsd.toFixed(2)}`;
	return `budget: admitted under $${preview.budget.ceilingUsd.toFixed(2)} session ceiling, $${preview.budget.currentUsd.toFixed(4)} spent, ${contract}`;
}

/**
 * Render the body. Waves in order, each step with its facts, then the argv a
 * code step will actually run, and last the budget the run is admitted under.
 */
export function formatFleetRunApprovalBody(subject: FleetRunApprovalSubject, width: number, scroll: number): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const rows: string[] = [];

	if (!subject.ok) {
		rows.push(theme.fg("error", `${subject.name}: preflight failed; nothing will be dispatched`));
		rows.push(rule(theme, contentWidth));
		for (const diagnostic of subject.diagnostics) {
			for (const line of diagnostic.split("\n")) {
				for (const wrapped of wrapTextWithAnsi(theme.fg("muted", line), contentWidth)) rows.push(wrapped);
			}
		}
	} else {
		const { preview } = subject;
		rows.push(theme.fg("dim", `${preview.name} · plan ${preview.planHash.slice(0, 12)}`));
		rows.push(rule(theme, contentWidth));
		for (const wave of preview.waves) {
			rows.push(theme.fg("accent", `wave ${wave.index}`));
			for (const step of wave.steps) {
				for (const line of wrapTextWithAnsi(theme.fg("muted", `  ${formatFleetRunPreviewStep(step)}`), contentWidth)) {
					rows.push(line);
				}
				if (step.argv !== undefined) {
					rows.push(theme.fg("dim", truncateToWidth(`    argv ${step.argv.join(" ")}`, contentWidth, "…", false)));
				}
			}
		}
		rows.push(rule(theme, contentWidth));
		for (const line of wrapTextWithAnsi(theme.fg("info", formatBudgetLine(preview)), contentWidth)) rows.push(line);
	}

	const maxScroll = Math.max(0, rows.length - FLEET_RUN_APPROVAL_VISIBLE_ROWS);
	const start = Math.max(0, Math.min(scroll, maxScroll));
	const shown = rows.slice(start, start + FLEET_RUN_APPROVAL_VISIBLE_ROWS);
	if (rows.length > FLEET_RUN_APPROVAL_VISIBLE_ROWS) {
		shown.push(theme.fg("dim", `(${start + 1}-${start + shown.length} of ${rows.length} lines)`));
	}
	return shown;
}

class FleetRunApprovalBody implements Component {
	scroll = 0;

	constructor(private readonly subject: FleetRunApprovalSubject) {}

	render(width: number): string[] {
		return formatFleetRunApprovalBody(this.subject, width, this.scroll);
	}

	invalidate(): void {}
}

/** Raw sequences this overlay answers. Everything else is swallowed. */
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ESC = "\x1b";

export function openFleetRunApprovalOverlay(tui: TUI, options: OpenFleetRunApprovalOverlayOptions): OverlayHandle {
	const body = new FleetRunApprovalBody(options.subject);
	const acceptable = options.subject.ok;
	let settled = false;

	const accept = (): void => {
		if (settled || !acceptable) return;
		settled = true;
		options.onAccept();
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		options.onCancel();
	};

	const focus = new FocusBox(body, {
		onInput: (data: string): void => {
			if (settled) return;
			if (data === KEY_UP) {
				body.scroll = Math.max(0, body.scroll - 1);
				tui.requestRender();
				return;
			}
			if (data === KEY_DOWN) {
				body.scroll += 1;
				tui.requestRender();
				return;
			}
			if (data === "\r" || data === "\n") {
				accept();
				return;
			}
			if (data === KEY_ESC) cancel();
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: fleetRunApprovalOverlayWidth(options.columns),
		title: FLEET_RUN_APPROVAL_OVERLAY_TITLE,
		footerHint: buildResponsiveHint(
			[...(acceptable ? [{ key: "Enter", verb: "dispatch" }] : []), { key: "↑↓", verb: "scroll" }],
			{ key: "Esc", verb: "cancel" },
		),
	});

	return {
		...handle,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
