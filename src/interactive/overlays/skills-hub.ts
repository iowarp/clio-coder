import type {
	MarketplaceDiscoveryResult,
	MarketplaceSkill,
	ResourceList,
	Skill,
} from "../../domains/resources/index.js";
import { discoverMarketplaceSkills, MARKETPLACE_UNCONFIGURED } from "../../domains/resources/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { NoticeLevel } from "../command-output.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/**
 * The Skills Hub: one multipane surface for every skill Clio can reach.
 * Installed skills group by scope, marketplace rows come from the same local
 * marketplace lookup the installer and `/skill:<name>` resolve through, Enter
 * inserts the invocation into the editor, and `i` installs in place. The hub
 * lists nothing the resolver cannot resolve; when the lookup is empty the hub
 * says so and names the remedy instead of drawing an inventory.
 */

const GROUP_PROJECT = "Project";
const GROUP_USER = "User";
const GROUP_MARKETPLACE = "Marketplace";
const GROUP_DIAGNOSTICS = "Diagnostics";

/** @internal exported for contract tests */
export const SKILLS_HUB_EMPTY =
	"no skills installed and no local marketplace configured. install one with `clio skills install <path|github-url>`, or point CLIO_SKILL_CATALOG_DIR at a skills/ catalog.";

export interface SkillsHubDeps {
	listSkills: () => ResourceList<Skill>;
	setEditorText: (text: string) => void;
	notice: (level: NoticeLevel, text: string) => void;
	/** Installs a marketplace skill by name; rejection text reaches the user. */
	installSkill: (name: string) => Promise<{ name: string; path: string; warnings: string[] }>;
	onClose: () => void;
	/** Injectable for tests; defaults to the local marketplace the installer uses. */
	discoverMarketplace?: () => MarketplaceDiscoveryResult;
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
export function buildInstalledItems(list: ResourceList<Skill>): ListOverlayItem[] {
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
					`**Invoke:** \`/skill:${skill.name} [task]\``,
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
export function buildMarketplaceItems(
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
				`**Invoke:** \`/skill:${skill.name} [task]\` (prompts to install first)`,
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
export function buildDiagnosticItems(
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

export function openSkillsHub(tui: TUI, deps: SkillsHubDeps): OverlayHandle {
	const discoverMarketplace = deps.discoverMarketplace ?? (() => discoverMarketplaceSkills());

	// The view reads this array by reference on every render, so an install
	// refresh mutates it in place and requests a render.
	const items: ListOverlayItem[] = [];

	const rebuildItems = (): void => {
		const list = deps.listSkills();
		const discovery = discoverMarketplace();
		const installedNames = new Set(list.items.map((skill) => skill.name));
		items.splice(
			0,
			items.length,
			...buildInstalledItems(list),
			...buildMarketplaceItems(discovery.skills, installedNames),
			...buildDiagnosticItems(list, discovery.diagnostics),
		);
	};

	rebuildItems();

	let closed = false;
	let installInFlight = false;
	const handle = openListOverlay(tui, {
		title: "Skills",
		items,
		filterable: true,
		layout: "split",
		emptyMessage: SKILLS_HUB_EMPTY,
		hints: [
			{ key: "Enter", verb: "invoke" },
			{ key: "i", verb: "install" },
		],
		onSelect: (item) => {
			if (item.group === GROUP_DIAGNOSTICS) return;
			const name = item.id.startsWith("marketplace:") ? item.id.slice("marketplace:".length) : item.id;
			deps.setEditorText(`/skill:${name} `);
			deps.onClose();
		},
		actions: {
			i: (item) => {
				if (!item.id.startsWith("marketplace:") || installInFlight) return;
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
						// An install that lands after the hub closed has nothing to redraw.
						if (!closed) {
							rebuildItems();
							tui.requestRender();
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
