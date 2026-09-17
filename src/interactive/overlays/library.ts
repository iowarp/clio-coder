/**
 * The Library: one full-screen browser over every recipe and package this
 * machine can see.
 *
 * Five categories, two modes and one selected scope. Browse lists install
 * targets, Installed lists what actually exists here, and the selected scope is
 * the copy every management key acts on. All three are drawn on a status row
 * that survives a narrow terminal, because they decide what the next keystroke
 * does and an operator should never have to remember them.
 *
 * The browser reads and reviews. It never writes: every managed change goes
 * through a plan the operator sees first, and the outcome that comes back
 * separates the write, the resources and the session refresh.
 */

import type { LibraryImportPlan } from "../../domains/interop/index.js";
import { applyLibraryImport, planLibraryImport, releaseLibraryImport } from "../../domains/interop/index.js";
import type { PluginScope } from "../../domains/plugins/types.js";
import type {
	LibraryCopyInspection,
	LibraryEntryKind,
	LibraryInventory,
	LibraryInventoryOptions,
} from "../../domains/resources/index.js";
import { inspectLibraryCopy, libraryImportOutcome, readLibraryInventory } from "../../domains/resources/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { NoticeLevel } from "../command-output.js";
import type { LibraryLifecyclePlan, LibraryLifecyclePort, LibraryOperation } from "./library-lifecycle.js";
import {
	buildLibraryRows,
	type LibraryMode,
	type LibraryRowActions,
	type LibraryRowSet,
	type LibraryRowSubject,
	type LibraryView,
	libraryRowActions,
	libraryStatusLine,
	libraryUseInvocation,
	selectForCategory,
} from "./library-model.js";
import { openLibraryImportOverlay, openLibraryReviewOverlay } from "./library-review.js";
import { isLibraryTab, LIBRARY_TABS } from "./library-tabs.js";
import { type ListOverlayHandle, type ListOverlayItem, type ListOverlayTab, openListOverlay } from "./list-overlay.js";

export { isLibraryTab, LIBRARY_TABS };

export const LIBRARY_TITLE = "Library";

/** @internal exported for contract tests */
export const LIBRARY_EMPTY_BROWSE =
	"No packages of this kind in the index. Browse counts packages, not runnable recipes. Press b for loaded recipes in Installed. Register one with clio-coder library register <path>, or press o to import from another local agent.";
/** @internal exported for contract tests */
export const LIBRARY_EMPTY_INSTALLED =
	"No entries of this kind are listed by the Library inventory. Action scope selects a package destination, not which recipes can run. Press b for installable packages.";

export interface LibraryOverlayDeps {
	/** The package lifecycle. Plans are reviewed before anything is written. */
	lifecycle: LibraryLifecyclePort;
	setEditorText: (text: string) => void;
	notice: (level: NoticeLevel, text: string) => void;
	onClose: () => void;
	/** Category the browser opens on. */
	initialTab?: LibraryEntryKind;
	initialMode?: LibraryMode;
	initialScope?: PluginScope;
	/** A package ref or resource key to select on open, from `/library inspect <ref>`. */
	focus?: string;
	/** An operation to review immediately on the focused row, from `/library install <ref>`. */
	intent?: LibraryOperation;
	/** A path or URL to import, from `/library import <path-or-url>`. */
	importSource?: string;
	cwd?: string;
	/** Opens the `/fleet run` approval preview for an installed fleet. */
	openFleetRun?: (name: string) => void;
	/** Opens the local-agent discovery and adoption surface. Never called on open. */
	openImport?: () => void;
	/** Injectable for tests; defaults to the shared inventory read. */
	readInventory?: (options: LibraryInventoryOptions) => LibraryInventory;
	/** Injectable for tests; defaults to the shared explicit copy inspection. */
	inspectCopy?: (ref: string, options: { cwd?: string; scope?: PluginScope }) => LibraryCopyInspection;
	/** Injectable for tests; defaults to the framed review overlay. */
	openReview?: typeof openLibraryReviewOverlay;
	/** Injectable for tests; defaults to the live terminal width. */
	columns?: () => number;
	/** Injectable for tests; defaults to the framed import review. */
	openImportReview?: typeof openLibraryImportOverlay;
	/** Injectable for tests; defaults to the shared full-screen list overlay. */
	openList?: typeof openListOverlay;
	/** Injectable for tests; defaults to `planLibraryImport`. */
	planImport?: typeof planLibraryImport;
	/** Injectable for tests; defaults to `applyLibraryImport`. */
	applyImport?: typeof applyLibraryImport;
	/**
	 * Injectable for tests; defaults to one microtask, so the host has assigned
	 * this overlay's handle before an opening intent puts another one on screen.
	 */
	scheduleInitial?: (run: () => void) => void;
}

/** The typed reference a management key sends to the lifecycle, or why it cannot. */
function requestRefFor(subject: LibraryRowSubject): { ref: string; reason?: string } {
	if (subject.kind === "package" || subject.kind === "hint") return { ref: subject.record.ref };
	if (subject.kind === "copy") return { ref: subject.copy.ref };
	if (subject.kind === "member") return { ref: subject.owner.ref };
	if (subject.kind === "recipe")
		return subject.resource.owner
			? { ref: subject.resource.owner.ref }
			: {
					ref: "",
					reason:
						subject.resource.source.class === "core"
							? `${subject.resource.name} is a core recipe and has no package to manage.`
							: `${subject.resource.name} was found directly in a resource root, so there is no package to manage.`,
				};
	return { ref: "", reason: "This row is a notice, not a package." };
}

export function openLibraryOverlay(tui: TUI, deps: LibraryOverlayDeps): OverlayHandle {
	const cwd = deps.cwd ?? process.cwd();
	const read = deps.readInventory ?? readLibraryInventory;
	const inspect = deps.inspectCopy ?? inspectLibraryCopy;
	const openReview = deps.openReview ?? openLibraryReviewOverlay;
	const columns = deps.columns ?? (() => (typeof process.stdout.columns === "number" ? process.stdout.columns : 100));

	const view: LibraryView = {
		category: deps.initialTab ?? "plugin",
		mode: deps.initialMode ?? "browse",
		scope: deps.initialScope ?? "user",
	};

	let closed = false;
	let busy = false;
	/**
	 * The review on screen and how to abandon it.
	 *
	 * A browser that closes while a plan is open would otherwise leave a staged
	 * source on disk and a modal with nothing routing keys to it. Holding the
	 * child here is what lets `hide()` release the one and close the other.
	 */
	let child: { hide: () => void; release: () => void } | null = null;
	/** The row whose install was refused for missing requirements; a second `i` includes them. */
	let pendingWithRequirements: string | null = null;

	/**
	 * One inventory read per rebuild, shared by all five tabs.
	 *
	 * The loaders enumerate their roots for collision precedence whichever kind
	 * is asked for, so reading once and projecting per category costs one pass
	 * instead of five.
	 */
	let inventoryCache: LibraryInventory | null = null;
	let inspectionCache: { ref: string; scope?: PluginScope; inspection: LibraryCopyInspection } | null = null;
	let failure: string | undefined;
	const inventory = (): LibraryInventory => {
		if (inventoryCache) return inventoryCache;
		try {
			inventoryCache = read({ cwd });
			failure = undefined;
		} catch (error) {
			failure = `Library read failed: ${error instanceof Error ? error.message : String(error)}`;
			inventoryCache = {
				version: 1,
				generatedAt: new Date().toISOString(),
				cwd,
				audience: "operator",
				packages: [],
				copies: [],
				resources: [],
				diagnostics: [],
				truncated: { packages: false, copies: false, resources: false },
			};
		}
		return inventoryCache;
	};
	const invalidate = (): void => {
		inventoryCache = null;
		inspectionCache = null;
	};

	const inspection = (): LibraryCopyInspection | undefined => {
		const member = view.member;
		if (!member) return undefined;
		if (inspectionCache && inspectionCache.ref === member.ref && inspectionCache.scope === member.scope)
			return inspectionCache.inspection;
		try {
			const result = inspect(member.ref, { cwd, ...(member.scope ? { scope: member.scope } : {}) });
			inspectionCache = { ref: member.ref, ...(member.scope ? { scope: member.scope } : {}), inspection: result };
			return result;
		} catch (error) {
			failure = `${member.ref}: ${error instanceof Error ? error.message : String(error)}`;
			view.member = undefined;
			return undefined;
		}
	};

	/** Rows for one category, and the subjects behind them, rebuilt on demand. */
	let rowSet: LibraryRowSet = { items: [], subjects: new Map(), notices: 0, truncated: false };
	const rowsFor = (category: LibraryEntryKind): ListOverlayItem[] => {
		const scoped: LibraryView = { ...view, category };
		const set = buildLibraryRows({
			inventory: selectForCategory(inventory(), scoped),
			view: scoped,
			...(scoped.category === view.category && view.member ? { inspection: inspection() } : {}),
			...(failure ? { failure } : {}),
		});
		if (category === view.category) rowSet = set;
		return set.items.filter((item) => set.subjects.get(item.id)?.kind !== "notice");
	};

	const tabs: ListOverlayTab[] = LIBRARY_TABS.map((tab) => ({
		id: tab.id,
		label: tab.label,
		items: () => rowsFor(tab.id),
		countLabel: (count) => {
			const unit = view.member && tab.id === view.category ? "member" : view.mode === "browse" ? "package" : "entry";
			return `${count} ${count === 1 ? unit : unit === "entry" ? "entries" : `${unit}s`}`;
		},
	}));

	// eslint-disable-next-line prefer-const -- the action closures need the handle they are opened from.
	let handle: ListOverlayHandle;

	const selected = (item: ListOverlayItem | undefined): LibraryRowSubject | undefined =>
		item ? rowSet.subjects.get(item.id) : undefined;

	const redraw = (keepSelection?: string): void => {
		if (closed) return;
		invalidate();
		handle.refreshTabs();
		if (keepSelection) handle.selectById(keepSelection);
	};

	/**
	 * Review one managed change and, only if the operator accepts it, apply it.
	 *
	 * Nothing here writes. The plan is built, the browser steps aside so the
	 * review owns the screen, and the two exits are exact: cancel releases the
	 * staged source and writes nothing, and an applied plan comes back with the
	 * outcome the list is then redrawn against.
	 */
	const manage = (operation: LibraryOperation, item: ListOverlayItem | undefined): void => {
		if (busy) return;
		const subject = selected(item);
		if (!subject) {
			deps.notice("warn", "Select a row first; b, s, o and R work without one.");
			return;
		}
		const actions = libraryRowActions(subject, view);
		const allowed: Record<LibraryOperation, boolean> = {
			install: actions.install,
			update: actions.update,
			enable: actions.enable,
			disable: actions.enable,
			remove: actions.remove,
		};
		const { ref, reason } = requestRefFor(subject);
		if (!ref || !allowed[operation]) {
			deps.notice("warn", reason ?? actions.reasons[0] ?? `${operation} is not available on this row.`);
			return;
		}
		const withRequirements = operation === "install" && pendingWithRequirements === ref;
		let plan: LibraryLifecyclePlan;
		try {
			plan = deps.lifecycle.plan({
				operation,
				ref,
				scope: view.scope,
				cwd,
				...(withRequirements ? { withRequirements: true } : {}),
			});
		} catch (error) {
			deps.notice("error", `${ref}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const missing = plan.steps.flatMap((step) => step.dependencies.missing);
		if (operation === "install" && !plan.applicable && missing.length > 0 && !withRequirements) {
			deps.lifecycle.release(plan);
			pendingWithRequirements = ref;
			deps.notice("error", `${ref} needs ${missing.join(", ")}; press i again to review them with it.`);
			return;
		}
		pendingWithRequirements = null;
		busy = true;
		const selectionId = item?.id;
		const restore = (): void => {
			busy = false;
			if (closed) return;
			handle.setHidden(false);
			handle.focus();
		};
		handle.setHidden(true);
		child = { hide: () => review.hide(), release: () => deps.lifecycle.release(plan) };
		const review = openReview(tui, {
			plan,
			columns: columns(),
			commit: (accepted) => deps.lifecycle.apply(accepted),
			retryRefresh: () => deps.lifecycle.retryRefresh(cwd),
			onCancel: () => {
				child = null;
				deps.lifecycle.release(plan);
				restore();
				deps.notice("info", `${ref}: cancelled; nothing was written.`);
				review.hide();
			},
			onDone: (result) => {
				child = null;
				restore();
				const level: NoticeLevel = result.failed > 0 ? "error" : result.committed > 0 ? "success" : "info";
				deps.notice(
					level,
					`${ref}: ${result.committed} committed, ${result.failed} failed, ${result.unattempted} unattempted; session refresh ${result.refresh.status}.`,
				);
				// A partial batch still redraws: the writes that landed are real.
				if (result.committed > 0) redraw(selectionId);
				review.hide();
			},
		});
	};

	/**
	 * Review the exact source `/library import` named.
	 *
	 * The source the operator typed is the source that gets planned. Local-agent
	 * discovery is a different way in, reached with `o`, and it never stands in
	 * for a path or URL that was given explicitly.
	 */
	const importSource = (source: string): void => {
		if (busy) return;
		let plan: LibraryImportPlan;
		try {
			plan = (deps.planImport ?? planLibraryImport)(source, { cwd, scope: view.scope });
		} catch (error) {
			deps.notice("error", `import ${source}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		busy = true;
		const restore = (): void => {
			busy = false;
			if (closed) return;
			handle.setHidden(false);
			handle.focus();
		};
		handle.setHidden(true);
		child = { hide: () => review.hide(), release: () => releaseLibraryImport(plan) };
		const review = (deps.openImportReview ?? openLibraryImportOverlay)(tui, {
			plan,
			columns: columns(),
			commit: (accepted) => (deps.applyImport ?? applyLibraryImport)(accepted, true),
			outcome: (accepted, result) => {
				const outcome = libraryImportOutcome(accepted, result);
				const committed = outcome.status === "committed";
				return {
					planId: accepted.reviewFingerprint,
					dryRun: false,
					outcomes: [outcome],
					committed: committed ? 1 : 0,
					failed: outcome.status === "failed" ? 1 : 0,
					unattempted: outcome.status === "unattempted" ? 1 : 0,
					refresh: committed
						? deps.lifecycle.retryRefresh(cwd)
						: { status: "not-applicable", reason: "nothing was imported" },
				};
			},
			retryRefresh: () => deps.lifecycle.retryRefresh(cwd),
			onCancel: () => {
				child = null;
				// The staged copy of the vendor tree is released here. Cancel means the
				// reviewed bytes leave no trace, not merely that nothing was installed.
				releaseLibraryImport(plan);
				restore();
				deps.notice("info", `import ${source}: cancelled; nothing was written.`);
				review.hide();
			},
			onDone: (result) => {
				// Apply released the staged source itself, whether it installed or refused.
				child = null;
				restore();
				deps.notice(
					result.failed > 0 ? "error" : "success",
					`import ${source}: ${result.committed} committed, ${result.failed} failed; session refresh ${result.refresh.status}.`,
				);
				if (result.committed > 0) redraw();
				review.hide();
			},
		});
	};

	/** Fill the composer, or open the surface a fleet's use actually leads to. */
	const use = (item: ListOverlayItem | undefined): void => {
		const subject = selected(item);
		if (!subject) return;
		if (subject.kind !== "recipe") {
			deps.notice("info", "Only a loaded recipe has a use action; press Enter to open a package's members.");
			return;
		}
		const actions = libraryRowActions(subject, view);
		if (!actions.use) {
			deps.notice("warn", actions.reasons[0] ?? `${subject.resource.name} is not usable in this state.`);
			return;
		}
		if (subject.resource.kind === "fleet") {
			deps.openFleetRun?.(subject.resource.name);
			return;
		}
		const invocation = libraryUseInvocation(subject.resource.kind, subject.resource.name);
		if (!invocation) return;
		deps.setEditorText(invocation);
		deps.onClose();
	};

	/** Enter: open what this row contains. A package opens its members, never its own tab. */
	const open = (item: ListOverlayItem): void => {
		const subject = selected(item);
		if (!subject) return;
		if (subject.kind === "package") {
			const here = subject.record.copies.find((copy) => copy.scope === view.scope) ?? subject.record.copies[0];
			if (!here) {
				handle.toggleDetail();
				deps.notice(
					"info",
					`${subject.record.ref} is not installed here; its catalog hints describe what it says it contains.`,
				);
				return;
			}
			view.member = { ref: subject.record.ref, scope: here.scope };
		} else if (subject.kind === "copy") {
			view.member = { ref: subject.copy.ref, scope: subject.copy.scope };
		} else {
			handle.toggleDetail();
			return;
		}
		inspectionCache = null;
		handle.refreshTabs();
	};

	/** A child keeps the resource browser's cursor, search draft and focus intact. */
	const openNotices = (): void => {
		if (busy) return;
		busy = true;
		const items = rowSet.items.filter((item) => rowSet.subjects.get(item.id)?.kind === "notice");
		const close = (): void => {
			child = null;
			busy = false;
			notices.hide();
			if (closed) return;
			handle.setHidden(false);
			handle.focus();
		};
		handle.setHidden(true);
		const notices = (deps.openList ?? openListOverlay)(tui, {
			markerId: "library",
			title: "Library notices",
			items,
			filterable: true,
			explicitSearch: true,
			fullScreen: true,
			layout: "split",
			status: () => `${items.length} ${items.length === 1 ? "notice" : "notices"} · browse focus: n back`,
			emptyMessage:
				"No notices in this view. From browse focus, n returns to resources. Esc clears a filter or leaves search focus before returning to the parent browser.",
			globalHints: [{ key: "n", verb: "resources", critical: true }],
			globalActions: { n: close },
			onClose: close,
		});
		child = { hide: () => notices.hide(), release: () => {} };
		notices.toggleDetail();
	};

	const status = (width: number): string =>
		libraryStatusLine(
			view,
			{ rows: rowSet.items.length - rowSet.notices, notices: rowSet.notices, truncated: rowSet.truncated },
			width,
		);

	/**
	 * The keys the selected row actually offers.
	 *
	 * A footer is a promise. An available package that is not installed here has
	 * nothing to remove, and advertising `r` on it while hiding `i` told the
	 * operator the opposite of the truth. Each entry below is present only when
	 * the row under the cursor would accept that key; the reasons for the absent
	 * ones are in the detail pane.
	 */
	const hints = (selected: ListOverlayItem | undefined): Array<{ key: string; verb: string }> => {
		const subject = selected ? rowSet.subjects.get(selected.id) : undefined;
		if (!subject || subject.kind === "notice") return [];
		const actions = libraryRowActions(subject, view);
		const entries: Array<{ key: string; verb: string }> = [];
		if (actions.use) entries.push({ key: "v", verb: "use" });
		entries.push({ key: "Enter", verb: actions.open ? "members" : "detail" });
		if (actions.install) entries.push({ key: "i", verb: "install" });
		if (actions.enable)
			entries.push({
				key: "e",
				verb:
					subject.kind === "copy" && !subject.copy.enabled
						? "enable"
						: subject.kind === "member" && !subject.owner.enabled
							? "enable"
							: "disable",
			});
		if (actions.update) entries.push({ key: "u", verb: "update" });
		if (actions.remove) entries.push({ key: "r", verb: "remove" });
		return entries;
	};

	handle = (deps.openList ?? openListOverlay)(tui, {
		markerId: "library",
		title: LIBRARY_TITLE,
		items: [],
		tabs,
		// Always explicit: the list defaults to its first tab, which is Skills, while
		// this view's category defaults to Plugins. Letting those disagree drew one
		// tab's rows under another tab's name and pointed every action at the wrong
		// category.
		activeTabId: view.category,
		onTabChange: (tabId) => {
			if (isLibraryTab(tabId)) view.category = tabId;
			view.member = undefined;
			pendingWithRequirements = null;
			inspectionCache = null;
		},
		filterable: true,
		explicitSearch: true,
		fullScreen: true,
		layout: "split",
		emptyMessage: () => (view.mode === "browse" ? LIBRARY_EMPTY_BROWSE : LIBRARY_EMPTY_INSTALLED),
		status,
		onBack: {
			active: () => view.member !== undefined,
			back: () => {
				view.member = undefined;
				inspectionCache = null;
				handle.refreshTabs();
			},
		},
		globalHints: [
			{ key: "b", verb: "browse/installed", short: "view", critical: true },
			{ key: "s", verb: "user/project", short: "scope", critical: true },
			{ key: "n", verb: "notices", critical: true },
			{ key: "o", verb: "import" },
			{ key: "R", verb: "refresh" },
		],
		globalActions: {
			n: openNotices,
			b: () => {
				view.mode = view.mode === "browse" ? "installed" : "browse";
				view.member = undefined;
				redraw();
			},
			s: () => {
				view.scope = view.scope === "user" ? "project" : "user";
				deps.notice("info", `Library actions now select ${view.scope} scope.`);
				redraw();
			},
			o: () => {
				if (!deps.openImport) {
					deps.notice("warn", "Import is unavailable in this session.");
					return;
				}
				deps.notice("info", "Import reviews another local agent's resources before anything is written.");
				deps.openImport();
			},
			R: () => {
				redraw();
				deps.notice("info", "Library re-read from disk.");
			},
		},
		hints,
		onSelect: open,
		actions: {
			v: use,
			i: (item) => manage("install", item),
			u: (item) => manage("update", item),
			r: (item) => manage("remove", item),
			e: (item) => {
				const subject = selected(item);
				const enabled =
					subject?.kind === "copy"
						? subject.copy.enabled
						: subject?.kind === "member"
							? subject.owner.enabled
							: subject?.kind === "recipe"
								? true
								: undefined;
				manage(enabled === false ? "enable" : "disable", item);
			},
		},
		onClose: deps.onClose,
	});

	// The narrow layout opens with the selected inspector visible. Tab retains
	// its existing toggle; wide layouts already draw detail beside the list.
	handle.toggleDetail();

	/**
	 * What `/library <verb> <ref>` asked for, run after the caller has this
	 * handle.
	 *
	 * A review opened during construction would be assigned to the host's
	 * overlay slot and then immediately overwritten by the browser's own handle,
	 * which is how a modal ends up on screen with nothing routing keys to it.
	 * Deferring one turn keeps the two assignments in order.
	 */
	const start = (): void => {
		if (closed) return;
		if (deps.importSource) {
			importSource(deps.importSource);
			return;
		}
		if (!deps.focus) return;
		const target = [...rowSet.subjects.entries()].find(([id, subject]) => {
			if (subject.kind === "recipe") return subject.resource.key === deps.focus || subject.resource.name === deps.focus;
			if (subject.kind === "package") return subject.record.ref === deps.focus || subject.record.name === deps.focus;
			if (subject.kind === "copy") return subject.copy.ref === deps.focus || subject.copy.name === deps.focus;
			return id === deps.focus;
		});
		if (!target) {
			deps.notice(
				"warn",
				`${deps.focus} is not in this category. Use the arrow keys for another category, / to search, or a typed kind:name reference.`,
			);
			return;
		}
		handle.selectById(target[0]);
		if (deps.intent) manage(deps.intent, { id: target[0], label: "" });
	};
	(deps.scheduleInitial ?? queueMicrotask)(start);

	return {
		...handle,
		hide(): void {
			closed = true;
			// A pending review dies with the browser that opened it, and its staged
			// source is released rather than left behind in the temp tree.
			const pending = child;
			child = null;
			if (pending) {
				pending.release();
				pending.hide();
			}
			handle.hide();
		},
	};
}

/** @internal exported for contract tests */
export type { LibraryRowActions };
