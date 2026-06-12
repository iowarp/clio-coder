import type { ResourceList, Skill } from "../../domains/resources/index.js";
import {
	fetchRemoteMarketplace,
	fetchRemoteSkillDetail,
	getMarketplaceSkills,
	parseSkillMarkdown,
	type RemoteSkill,
} from "../../domains/resources/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { NoticeLevel } from "../command-output.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/**
 * The Skills Hub: one multipane surface for every skill Clio can reach.
 * Installed skills group by scope, marketplace skills hydrate in from the
 * GitHub repo without ever blocking first paint, Enter inserts the
 * invocation into the editor, and `i` installs a marketplace skill in place.
 */

const GROUP_PROJECT = "Project";
const GROUP_USER = "User";
const GROUP_MARKETPLACE = "Marketplace";
const GROUP_DIAGNOSTICS = "Diagnostics";

export interface SkillsHubDeps {
	listSkills: () => ResourceList<Skill>;
	dataDir: string;
	setEditorText: (text: string) => void;
	notice: (level: NoticeLevel, text: string) => void;
	/** Installs a marketplace skill by name; rejection text reaches the user. */
	installSkill: (name: string) => Promise<{ name: string; path: string; warnings: string[] }>;
	onClose: () => void;
	/** Injectable for tests; defaults to the live remote marketplace. */
	fetchMarketplace?: (dataDir: string) => Promise<RemoteSkill[]>;
	fetchSkillDetail?: (dataDir: string, name: string) => Promise<{ description?: string; body: string }>;
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

/** @internal exported for contract tests */
export function buildInstalledItems(list: ResourceList<Skill>): ListOverlayItem[] {
	return list.items.map((skill) => {
		const flagged = list.diagnostics.some((diag) => diagnosticTouchesSkill(diag.path, skill));
		const metaParts = [`${skill.scope}/${skill.source}`];
		if (!skill.trusted) metaParts.push("untrusted");
		if (flagged) metaParts.push("!");
		return {
			id: skill.name,
			label: skill.name,
			meta: metaParts.join(" · "),
			group: groupForScope(skill.scope),
			detail: () => {
				const parsed = parseSkillMarkdown(skill.content);
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
				lines.push("", "---", "", parsed.body.length > 0 ? parsed.body : skill.description);
				return lines;
			},
		};
	});
}

/** @internal exported for contract tests */
export function buildDiagnosticItems(list: ResourceList<Skill>): ListOverlayItem[] {
	return list.diagnostics.map((diag, index) => ({
		id: `diagnostic-${index}`,
		label: `${diag.type}: ${diag.message}`,
		...(diag.path ? { meta: diag.path } : {}),
		group: GROUP_DIAGNOSTICS,
		detail: () => [
			"# Skill diagnostic",
			`**Severity:** ${diag.type}`,
			`**Message:** ${diag.message}`,
			`**File:** ${diag.path ?? "(unknown)"}`,
		],
	}));
}

export function openSkillsHub(tui: TUI, deps: SkillsHubDeps): OverlayHandle {
	const lifecycle = new AbortController();
	const fetchMarketplace = deps.fetchMarketplace ?? ((dataDir: string) => fetchRemoteMarketplace(dataDir));
	const fetchDetail =
		deps.fetchSkillDetail ?? ((dataDir: string, name: string) => fetchRemoteSkillDetail(dataDir, name));

	// The view reads this array by reference on every render, so hydration and
	// install refreshes mutate it in place and request a render.
	const items: ListOverlayItem[] = [];
	const resolvedRemoteDetails = new Map<string, string[]>();
	const pendingRemoteDetails = new Set<string>();
	let marketplaceState: "loading" | "live" | "offline" = "loading";

	const marketplaceDetail = (skill: { name: string; description?: string; repoUrl: string }): (() => string[]) => {
		return () => {
			const resolved = resolvedRemoteDetails.get(skill.name);
			const header = [
				`# ${skill.name}`,
				`**Invoke:** \`/skill:${skill.name} [task]\` (installs on first use)`,
				`**Install now:** press \`i\``,
				`**Repo:** ${skill.repoUrl}`,
				...(marketplaceState === "offline" ? ["**Marketplace:** offline/cached listing"] : []),
			];
			if (resolved) return [...header, "", "---", "", ...resolved];
			if (!pendingRemoteDetails.has(skill.name) && !lifecycle.signal.aborted) {
				pendingRemoteDetails.add(skill.name);
				void (async () => {
					try {
						const detail = await fetchDetail(deps.dataDir, skill.name);
						const lines: string[] = [];
						if (detail.description) lines.push(detail.description, "");
						if (detail.body.length > 0) lines.push(detail.body);
						resolvedRemoteDetails.set(skill.name, lines.length > 0 ? lines : ["(no description published)"]);
					} catch {
						resolvedRemoteDetails.set(skill.name, ["(description unavailable offline)"]);
					}
					if (!lifecycle.signal.aborted) tui.requestRender();
				})();
			}
			return [...header, "", skill.description ?? "Loading description..."];
		};
	};

	const marketplaceItem = (skill: { name: string; description?: string; repoUrl: string }): ListOverlayItem => ({
		id: `marketplace:${skill.name}`,
		label: skill.name,
		meta: "marketplace",
		group: GROUP_MARKETPLACE,
		detail: marketplaceDetail(skill),
	});

	const rebuildItems = (): void => {
		const list = deps.listSkills();
		const installedNames = new Set(list.items.map((skill) => skill.name));
		const next: ListOverlayItem[] = [...buildInstalledItems(list)];
		const seenMarketplace = new Set<string>();
		for (const pinned of getMarketplaceSkills()) {
			if (installedNames.has(pinned.name) || seenMarketplace.has(pinned.name)) continue;
			seenMarketplace.add(pinned.name);
			next.push(marketplaceItem({ name: pinned.name, description: pinned.description, repoUrl: pinned.sourceUrl }));
		}
		for (const remote of remoteSkills) {
			if (installedNames.has(remote.name) || seenMarketplace.has(remote.name)) continue;
			seenMarketplace.add(remote.name);
			next.push(marketplaceItem(remote));
		}
		next.push(...buildDiagnosticItems(list));
		items.splice(0, items.length, ...next);
	};

	let remoteSkills: RemoteSkill[] = [];
	rebuildItems();

	void (async () => {
		try {
			remoteSkills = await fetchMarketplace(deps.dataDir);
			marketplaceState = "live";
		} catch {
			marketplaceState = "offline";
		}
		if (lifecycle.signal.aborted) return;
		rebuildItems();
		tui.requestRender();
	})();

	let installInFlight = false;
	const handle = openListOverlay(tui, {
		title: "Skills",
		mode: "commit",
		items,
		filterable: true,
		layout: "split",
		emptyMessage: "No skills found",
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
						if (!lifecycle.signal.aborted) {
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
			if (!lifecycle.signal.aborted) lifecycle.abort();
			handle.hide();
		},
	};
}
