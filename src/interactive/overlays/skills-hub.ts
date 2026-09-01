import type {
	LibraryDiscoveryResult,
	LibraryEntry,
	LibraryEntryKind,
	LibraryInstallPlan,
	LibraryRequirementStatus,
	MarketplaceDiscoveryResult,
	MarketplaceSkill,
	ResourceList,
	Skill,
} from "../../domains/resources/index.js";
import {
	classifyLibraryRequirements,
	discoverLibrary,
	discoverMarketplaceSkills,
	installLibraryPlan,
	libraryEntryInstalled,
	libraryEntryPin,
	libraryEntryRef,
	libraryInstallPath,
	MARKETPLACE_UNCONFIGURED,
	planLibraryInstall,
} from "../../domains/resources/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { NoticeLevel } from "../command-output.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import type { LibraryInstallConfirmSubject } from "./library-install-confirm.js";
import { openLibraryInstallConfirmOverlay } from "./library-install-confirm.js";
import { isLibraryTab, LIBRARY_TABS } from "./library-tabs.js";
import { type ListOverlayItem, type ListOverlayTab, openListOverlay } from "./list-overlay.js";

/**
 * The Skills Hub: one multipane surface for every resource Clio can reach.
 *
 * The Skills tab is the original view. Installed skills group by scope,
 * marketplace rows come from the same local marketplace lookup the installer
 * and `/skill <name>` resolve through, Enter inserts the invocation into the
 * editor, and `i` installs in place. The hub lists nothing the resolver cannot
 * resolve; when the lookup is empty the hub says so and names the remedy
 * instead of drawing an inventory.
 *
 * The Agents, Prompts, and Fleets tabs are the interactive half of the resource
 * library. Their rows come from the same `discoverLibrary()` the CLI's
 * `library list --kind` reads, their install runs the same plan-then-write pair
 * `library add` runs behind the same confirmation the `--yes` gate expresses,
 * and their requirement gate is the same classifier. Nothing here reaches
 * around the library domain into a private path.
 */

const GROUP_PROJECT = "Project";
const GROUP_USER = "User";
const GROUP_MARKETPLACE = "Marketplace";
const GROUP_DIAGNOSTICS = "Diagnostics";
const GROUP_INSTALLED = "Installed";
const GROUP_AVAILABLE = "Available";

export { isLibraryTab, LIBRARY_TABS };

export const SKILLS_HUB_TITLE = "Skills Hub";

/** Row id prefix for a library row, which is how an action tells the tabs apart. */
export const LIBRARY_ROW_PREFIX = "library:";

/** @internal exported for contract tests */
export const SKILLS_HUB_EMPTY =
	"no skills installed and no local marketplace configured. install one with `clio-coder skills install <path|github-url>`, or point CLIO_CODER_SKILL_CATALOG_DIR at a skills/ catalog.";

export interface SkillsHubDeps {
	listSkills: () => ResourceList<Skill>;
	setEditorText: (text: string) => void;
	notice: (level: NoticeLevel, text: string) => void;
	/** Installs a marketplace skill by name; rejection text reaches the user. */
	installSkill: (name: string) => Promise<{ name: string; path: string; warnings: string[] }>;
	onClose: () => void;
	/** Injectable for tests; defaults to the local marketplace the installer uses. */
	discoverMarketplace?: () => MarketplaceDiscoveryResult;
	/** Tab the hub opens on. `/skills` opens on Skills, `/library <kind>` on that kind. */
	initialTab?: LibraryEntryKind;
	/** Injectable for tests; defaults to the discovery `library list` reads. */
	discoverLibrary?: () => LibraryDiscoveryResult;
	/** Injectable for tests; defaults to the classifier `library add` gates on. */
	classifyRequirements?: (entry: LibraryEntry, catalog: ReadonlyArray<LibraryEntry>) => LibraryRequirementStatus;
	/** Injectable for tests; defaults to the planner `library add` prints from. */
	planInstall?: (entry: LibraryEntry) => LibraryInstallPlan;
	/** Injectable for tests; defaults to the writer `library add --yes` runs. */
	installPlan?: (plan: LibraryInstallPlan) => void;
	/** Injectable for tests; defaults to the pin-and-destination check the domain owns. */
	entryInstalled?: (entry: LibraryEntry) => boolean;
	/** Injectable for tests; defaults to the recorded pin for this entry. */
	entryPin?: (entry: LibraryEntry) => { sha256: string; sourceUrl: string } | undefined;
	/**
	 * The confirmation gate. Resolves true only when the operator accepted, and
	 * nothing is written before it does. Defaults to the framed confirmation
	 * overlay, which is the TUI spelling of `library add`'s `--yes`.
	 */
	confirmInstall?: (subject: LibraryInstallConfirmSubject) => Promise<boolean>;
	/** Opens the `/fleet run` approval preview for an installed fleet. */
	openFleetRun?: (name: string) => void;
}

/** Row and action context for one library tab, resolved once per rebuild. */
interface LibraryTabContext {
	discovery: LibraryDiscoveryResult;
	installed: (entry: LibraryEntry) => boolean;
	pin: (entry: LibraryEntry) => { sha256: string; sourceUrl: string } | undefined;
	unresolved: (entry: LibraryEntry) => LibraryEntry[];
}

/**
 * The composer text or the surface a `use` on this entry leads to.
 *
 * A fleet has no composer spelling because its `use` opens the `/fleet run`
 * approval preview instead, so this returns null for one and the caller routes
 * it there.
 */
function libraryUseInvocation(entry: Pick<LibraryEntry, "kind" | "name">): string | null {
	if (entry.kind === "fleet") return null;
	if (entry.kind === "agent") return `/run ${entry.name} `;
	if (entry.kind === "prompt") return `/${entry.name} `;
	return `/skill ${entry.name} `;
}

function groupForScope(scope: string): string {
	if (scope === "project") return GROUP_PROJECT;
	if (scope === "user") return GROUP_USER;
	return scope.charAt(0).toUpperCase() + scope.slice(1);
}

function diagnosticTouchesSkill(diagnosticPath: string | undefined, skill: Skill): boolean {
	if (!diagnosticPath) return false;
	return diagnosticPath === skill.filePath || diagnosticPath.startsWith(skill.baseDir);
}

/**
 * The SKILL.md body without its frontmatter block. A file with no frontmatter,
 * or an unterminated one, is all body; the loader has already reported those as
 * diagnostics, so the detail pane shows the text rather than an error.
 */
function skillBody(content: string): string {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return content;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return content;
	return lines
		.slice(end + 1)
		.join("\n")
		.trim();
}

/** @internal exported for contract tests */
function buildInstalledItems(list: ResourceList<Skill>): ListOverlayItem[] {
	return list.items.map((skill) => {
		const theme = clioTheme();
		const flagged = list.diagnostics.some((diag) => diagnosticTouchesSkill(diag.path, skill));
		const metaParts = [`${skill.scope}/${skill.source}`];
		if (!skill.trusted) metaParts.push("untrusted");
		if (flagged) metaParts.push(theme.fg("warning", GLYPH.warnInline));
		return {
			id: skill.name,
			label: skill.name,
			meta: metaParts.join(" · "),
			group: groupForScope(skill.scope),
			detail: () => {
				const lines = [
					`# ${skill.name}`,
					`**Invoke:** \`/skill ${skill.name} [task]\``,
					`**Source:** \`${skill.filePath}\``,
					`**Scope:** ${skill.scope}/${skill.source}${skill.trusted ? "" : " (untrusted)"}`,
				];
				if (flagged) {
					const messages = list.diagnostics
						.filter((diag) => diagnosticTouchesSkill(diag.path, skill))
						.map((diag) => `- ${diag.type}: ${diag.message}`);
					lines.push("", "**Diagnostics:**", ...messages);
				}
				const body = skillBody(skill.content);
				lines.push("", "---", "", body.length > 0 ? body : skill.description);
				return lines;
			},
		};
	});
}

/** @internal exported for contract tests */
function buildMarketplaceItems(
	skills: ReadonlyArray<MarketplaceSkill>,
	installed: ReadonlySet<string>,
): ListOverlayItem[] {
	const items: ListOverlayItem[] = [];
	const seen = new Set<string>();
	for (const skill of skills) {
		if (installed.has(skill.name) || seen.has(skill.name)) continue;
		seen.add(skill.name);
		const metaParts: string[] = [skill.origin];
		if (skill.version) metaParts.push(`v${skill.version}`);
		items.push({
			id: `marketplace:${skill.name}`,
			label: skill.name,
			meta: metaParts.join(" · "),
			group: GROUP_MARKETPLACE,
			detail: () => [
				`# ${skill.name}`,
				`**Invoke:** \`/skill ${skill.name} [task]\` (prompts to install first)`,
				"**Install now:** press `i`",
				`**Source:** \`${skill.sourceUrl}\``,
				`**Origin:** ${skill.origin}${skill.category ? ` (${skill.category})` : ""}${skill.audit ? ` · audit ${skill.audit}` : ""}`,
				"",
				"---",
				"",
				skill.description,
			],
		});
	}
	return items;
}

/** @internal exported for contract tests */
function buildDiagnosticItems(
	list: ResourceList<Skill>,
	marketplaceDiagnostics: ReadonlyArray<string> = [],
): ListOverlayItem[] {
	const theme = clioTheme();
	const items = list.diagnostics.map((diag, index) => {
		const marker = diag.type === "error" ? theme.fg("error", GLYPH.error) : theme.fg("warning", GLYPH.warnInline);
		return {
			id: `diagnostic-${index}`,
			label: `${marker} ${diag.message}`,
			...(diag.path ? { meta: diag.path } : {}),
			group: GROUP_DIAGNOSTICS,
			detail: () => [
				"# Skill diagnostic",
				`**Severity:** ${diag.type}`,
				`**Message:** ${diag.message}`,
				`**File:** ${diag.path ?? "(unknown)"}`,
			],
		};
	});
	// An unconfigured marketplace is the empty state, not a diagnostic; anything
	// else the lookup reports (an unreadable index, a broken catalog package) is
	// a real failure and gets its own row.
	for (const message of marketplaceDiagnostics) {
		if (message === MARKETPLACE_UNCONFIGURED) continue;
		items.push({
			id: `marketplace-diagnostic-${items.length}`,
			label: `${theme.fg("warning", GLYPH.warnInline)} ${message}`,
			meta: "marketplace",
			group: GROUP_DIAGNOSTICS,
			detail: () => ["# Marketplace diagnostic", `**Message:** ${message}`],
		});
	}
	return items;
}

/** @internal exported for contract tests */
function libraryRowId(entry: Pick<LibraryEntry, "kind" | "name">): string {
	return `${LIBRARY_ROW_PREFIX}${libraryEntryRef(entry)}`;
}

/**
 * One kind's rows: the same columns the Skills tab shows where they apply, plus
 * the requirements this entry still needs.
 *
 * The requires column carries the names rather than a count, because the names
 * are what the refusal will say and what the second confirmation will install.
 * It renders in the warning token: an entry with an unmet requirement is
 * listable and readable but not installable on its own.
 *
 * @internal exported for contract tests
 */
function buildLibraryItems(kind: LibraryEntryKind, context: LibraryTabContext): ListOverlayItem[] {
	const theme = clioTheme();
	return context.discovery.entries
		.filter((entry) => entry.kind === kind)
		.map((entry) => {
			const installed = context.installed(entry);
			const pin = context.pin(entry);
			const unresolved = context.unresolved(entry).map(libraryEntryRef);
			const metaParts: string[] = [entry.origin];
			if (entry.version) metaParts.push(`v${entry.version}`);
			metaParts.push(installed ? "installed" : "available");
			metaParts.push(pin ? `pin ${pin.sha256.slice(0, 8)}` : "unpinned");
			if (unresolved.length > 0) metaParts.push(theme.fg("warning", `requires ${unresolved.join(", ")}`));
			return {
				id: libraryRowId(entry),
				label: entry.name,
				meta: metaParts.join(" · "),
				group: installed ? GROUP_INSTALLED : GROUP_AVAILABLE,
				detail: () => {
					const use = libraryUseInvocation(entry);
					const lines = [
						`# ${entry.name}`,
						`**Kind:** ${entry.kind}`,
						`**Use:** ${use === null ? "`Enter` opens the /fleet run approval preview" : `\`${use.trim()}\``}`,
						`**State:** ${installed ? "installed" : "available"}${pin ? ` · pinned ${pin.sha256.slice(0, 12)}` : " · unpinned"}`,
						`**Destination:** \`${libraryInstallPath(entry)}\``,
						`**Source:** \`${entry.sourceUrl}\``,
						`**Origin:** ${entry.origin}`,
					];
					if ((entry.requires ?? []).length > 0) {
						lines.push(`**Requires:** ${(entry.requires ?? []).join(", ")}`);
					}
					if (unresolved.length > 0) {
						lines.push(`**Unresolved:** ${unresolved.join(", ")}`, "", "Press `i` twice to install them with it.");
					} else if (!installed) {
						lines.push("", "**Install now:** press `i`");
					}
					lines.push("", "---", "", entry.description);
					return lines;
				},
			};
		});
}

/**
 * Diagnostic rows for a library tab. `discoverLibrary` drops an entry whose
 * requirements are missing, malformed, or cyclic and records why; a tab that
 * silently omitted those would be the inventory this hub refuses to draw.
 *
 * @internal exported for contract tests
 */
function buildLibraryDiagnosticItems(discovery: LibraryDiscoveryResult): ListOverlayItem[] {
	const theme = clioTheme();
	return discovery.diagnostics
		.filter((message) => message !== MARKETPLACE_UNCONFIGURED)
		.map((message, index) => ({
			id: `library-diagnostic-${index}`,
			label: `${theme.fg("warning", GLYPH.warnInline)} ${message}`,
			meta: "library",
			group: GROUP_DIAGNOSTICS,
			detail: () => ["# Library diagnostic", `**Message:** ${message}`],
		}));
}

/** What one attempted library install did, in the terms the hub reports it. */
export type LibraryInstallOutcome =
	| { status: "installed"; refs: string[] }
	| { status: "cancelled" }
	| { status: "refused"; unresolved: string[] }
	| { status: "already-installed" }
	| { status: "failed"; message: string };

/** The library domain calls one install needs, resolved before it runs. */
export interface LibraryInstallRunner {
	discovery: LibraryDiscoveryResult;
	classify: (entry: LibraryEntry, catalog: ReadonlyArray<LibraryEntry>) => LibraryRequirementStatus;
	plan: (entry: LibraryEntry) => LibraryInstallPlan;
	write: (plan: LibraryInstallPlan) => void;
	installed: (entry: LibraryEntry) => boolean;
	confirm: (subject: LibraryInstallConfirmSubject) => Promise<boolean>;
}

/**
 * Install one library entry through the same sequence `library add` runs.
 *
 * The order is the CLI's order and the refusals are the CLI's refusals: an
 * entry with an unmet requirement is refused by name and nothing is planned, a
 * plan is built and shown before anything is written, and the writes happen
 * only after the confirmation resolves true. A cancelled confirmation is a run
 * in which no file changed.
 *
 * @internal exported for contract tests
 */
async function runLibraryInstall(
	entry: LibraryEntry,
	runner: LibraryInstallRunner,
	options: { withRequirements: boolean },
): Promise<LibraryInstallOutcome> {
	if (runner.installed(entry)) return { status: "already-installed" };
	let requirements: LibraryRequirementStatus;
	let plans: LibraryInstallPlan[];
	try {
		requirements = runner.classify(entry, runner.discovery.entries);
		if (requirements.unsatisfied.length > 0 && !options.withRequirements) {
			return { status: "refused", unresolved: requirements.unsatisfied.map(libraryEntryRef) };
		}
		plans = [...(options.withRequirements ? requirements.unsatisfied : []), entry].map(runner.plan);
	} catch (error) {
		return { status: "failed", message: error instanceof Error ? error.message : String(error) };
	}
	const accepted = await runner.confirm({
		entryRef: libraryEntryRef(entry),
		writes: plans.map((plan) => ({ ref: libraryEntryRef(plan.entry), path: plan.path, sha256: plan.sha256 })),
		requirements: options.withRequirements ? requirements.unsatisfied.map(libraryEntryRef) : [],
		satisfied: requirements.satisfied.map(libraryEntryRef),
	});
	if (!accepted) return { status: "cancelled" };
	const written: string[] = [];
	try {
		for (const plan of plans) {
			runner.write(plan);
			written.push(libraryEntryRef(plan.entry));
		}
	} catch (error) {
		return { status: "failed", message: error instanceof Error ? error.message : String(error) };
	}
	return { status: "installed", refs: written };
}

export function openSkillsHub(tui: TUI, deps: SkillsHubDeps): OverlayHandle {
	const discoverMarketplace = deps.discoverMarketplace ?? (() => discoverMarketplaceSkills());
	const readLibrary = deps.discoverLibrary ?? (() => discoverLibrary());
	const classify = deps.classifyRequirements ?? classifyLibraryRequirements;
	const plan = deps.planInstall ?? planLibraryInstall;
	const write = deps.installPlan ?? installLibraryPlan;
	const installed = deps.entryInstalled ?? libraryEntryInstalled;
	const pin = deps.entryPin ?? libraryEntryPin;

	// Rebuilt rather than mutated in place: the view memoizes its frame on the row
	// set, so a spliced array leaves an installed skill drawn as installable.
	const buildRows = (): ListOverlayItem[] => {
		const list = deps.listSkills();
		const discovery = discoverMarketplace();
		const installedNames = new Set(list.items.map((skill) => skill.name));
		return [
			...buildInstalledItems(list),
			...buildMarketplaceItems(discovery.skills, installedNames),
			...buildDiagnosticItems(list, discovery.diagnostics),
		];
	};

	// One discovery pass feeds all three library tabs. The tab bar asks every tab
	// for its rows on each rebuild, and four independent catalog reads per
	// keystroke would be four answers to the same question.
	let libraryCache: LibraryTabContext | null = null;
	const libraryContext = (): LibraryTabContext => {
		if (libraryCache) return libraryCache;
		const discovery = readLibrary();
		libraryCache = {
			discovery,
			installed,
			pin,
			unresolved: (entry) => {
				try {
					return classify(entry, discovery.entries).unsatisfied;
				} catch {
					// A requirement that will not resolve is already a diagnostic row on
					// this tab; a row that cannot answer the question reports none rather
					// than taking the whole rebuild down.
					return [];
				}
			},
		};
		return libraryCache;
	};
	const invalidateLibrary = (): void => {
		libraryCache = null;
	};

	const buildLibraryRows = (kind: LibraryEntryKind): ListOverlayItem[] => {
		const context = libraryContext();
		return [...buildLibraryItems(kind, context), ...buildLibraryDiagnosticItems(context.discovery)];
	};

	const entryForRow = (item: ListOverlayItem): LibraryEntry | undefined => {
		if (!item.id.startsWith(LIBRARY_ROW_PREFIX)) return undefined;
		const ref = item.id.slice(LIBRARY_ROW_PREFIX.length);
		return libraryContext().discovery.entries.find((candidate) => libraryEntryRef(candidate) === ref);
	};

	const tabs: ListOverlayTab[] = LIBRARY_TABS.map((tab) => ({
		id: tab.id,
		label: tab.label,
		items: tab.id === "skill" ? buildRows : () => buildLibraryRows(tab.id),
	}));

	let closed = false;
	let installInFlight = false;
	/**
	 * The row whose requirements were just refused. A second `i` on that row is
	 * the install-with-requirements offer, so the refusal names what is missing
	 * before any confirmation lists what would be written.
	 */
	let pendingWithRequirements: string | null = null;

	const columns = (): number => (typeof process.stdout.columns === "number" ? process.stdout.columns : 100);

	// eslint-disable-next-line prefer-const -- the confirmation closure needs the handle it is opened from.
	let handle: ReturnType<typeof openListOverlay>;

	const confirmInstall =
		deps.confirmInstall ??
		((subject: LibraryInstallConfirmSubject): Promise<boolean> =>
			new Promise<boolean>((resolve) => {
				handle.setHidden(true);
				const settle = (accepted: boolean): void => {
					if (!closed) {
						handle.setHidden(false);
						handle.focus();
					}
					resolve(accepted);
				};
				const confirmation = openLibraryInstallConfirmOverlay(tui, {
					subject,
					columns: columns(),
					onAccept: () => {
						settle(true);
						confirmation.hide();
					},
					onCancel: () => {
						settle(false);
						confirmation.hide();
					},
				});
			}));

	const useEntry = (entry: LibraryEntry): void => {
		if (!installed(entry)) {
			deps.notice("warn", `${libraryEntryRef(entry)} is not installed; press i to install it`);
			return;
		}
		if (entry.kind === "fleet") {
			deps.openFleetRun?.(entry.name);
			return;
		}
		const invocation = libraryUseInvocation(entry);
		if (invocation === null) return;
		deps.setEditorText(invocation);
		deps.onClose();
	};

	const installEntry = (entry: LibraryEntry): void => {
		const ref = libraryEntryRef(entry);
		const withRequirements = pendingWithRequirements === ref;
		installInFlight = true;
		void (async () => {
			const outcome = await runLibraryInstall(
				entry,
				{ discovery: libraryContext().discovery, classify, plan, write, installed, confirm: confirmInstall },
				{ withRequirements },
			);
			installInFlight = false;
			if (outcome.status === "refused") {
				pendingWithRequirements = ref;
				deps.notice("error", `${ref} needs ${outcome.unresolved.join(", ")}; press i again to install them with it`);
				return;
			}
			pendingWithRequirements = null;
			if (outcome.status === "already-installed") deps.notice("info", `${ref} is already installed`);
			else if (outcome.status === "cancelled") deps.notice("info", `${ref}: cancelled; nothing was written`);
			else if (outcome.status === "failed") deps.notice("error", `library install failed: ${outcome.message}`);
			else deps.notice("success", `installed ${outcome.refs.join(", ")}`);
			// An install that lands after the hub closed has nothing to redraw.
			if (!closed && outcome.status === "installed") {
				invalidateLibrary();
				handle.refreshTabs();
			}
		})();
	};

	handle = openListOverlay(tui, {
		markerId: "skills-hub",
		title: SKILLS_HUB_TITLE,
		items: [],
		tabs,
		...(deps.initialTab ? { activeTabId: deps.initialTab } : {}),
		onTabChange: () => {
			pendingWithRequirements = null;
		},
		filterable: true,
		layout: "split",
		emptyMessage: SKILLS_HUB_EMPTY,
		hints: [
			{ key: "Enter", verb: "use" },
			{ key: "i", verb: "install" },
		],
		onSelect: (item) => {
			if (item.group === GROUP_DIAGNOSTICS) return;
			const entry = entryForRow(item);
			if (entry) {
				useEntry(entry);
				return;
			}
			const name = item.id.startsWith("marketplace:") ? item.id.slice("marketplace:".length) : item.id;
			deps.setEditorText(`/skill ${name} `);
			deps.onClose();
		},
		actions: {
			i: (item) => {
				if (installInFlight) return;
				const entry = entryForRow(item);
				if (entry) {
					installEntry(entry);
					return;
				}
				if (!item.id.startsWith("marketplace:")) return;
				const name = item.id.slice("marketplace:".length);
				installInFlight = true;
				void (async () => {
					try {
						const result = await deps.installSkill(name);
						for (const warning of result.warnings) deps.notice("warn", `skill ${name}: ${warning}`);
						deps.notice("success", `installed skill ${name} at ${result.path}`);
					} catch (err) {
						deps.notice("error", `skill install failed: ${err instanceof Error ? err.message : String(err)}`);
					} finally {
						installInFlight = false;
						if (!closed) {
							invalidateLibrary();
							handle.refreshTabs();
						}
					}
				})();
			},
		},
		onClose: deps.onClose,
	});

	return {
		...handle,
		hide(): void {
			closed = true;
			handle.hide();
		},
	};
}
