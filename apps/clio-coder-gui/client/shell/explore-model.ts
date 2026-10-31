import type { IconName } from "../design/icons.js";
import { SETTINGS_SECTIONS } from "./shell-model.js";

const GROUPS = [
	{ label: "Workbench", detail: "Sessions and research machines", sections: ["sessions", "machines"] },
	{ label: "Capabilities", detail: "What Clio can use", sections: ["library", "skills", "toolchain", "interop"] },
	{
		label: "Research activity",
		detail: "Work, results and recorded evidence",
		sections: ["fleet", "traces", "evidence", "usage"],
	},
	{
		label: "Settings",
		detail: "Make Clio work for you",
		sections: ["general", "models", "safety", "context", "all", "system"],
	},
];
const EXTRA = [
	{ id: "skills", label: "Skills", path: "/skills", icon: "skills" },
	{ id: "interop", label: "Other coding agents", path: "/system/interop", icon: "system" },
] as const;
const KEYWORDS: Readonly<Record<string, string>> = {
	machines: "ssh remote lab workstation server",
	usage: "cost costs spending tokens calls models",
	toolchain: "tools executables install setup",
	traces: "replay timeline execution events",
	evidence: "reports records findings provenance checks",
	fleet: "agents delegation workers teamwork",
	library: "recipes plugins extensions verifiers",
	safety: "permissions approvals spending limits",
	context: "memory compaction continuity",
	system: "health diagnostics status folders",
	interop: "codex claude external agents",
};
export type ExploreSection = { id: string; label: string; path: string; icon: IconName };

export function exploreGroups(query: string) {
	const sections: readonly ExploreSection[] = [...SETTINGS_SECTIONS, ...EXTRA];
	const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return GROUPS.map((group) => ({
		...group,
		sections: group.sections.flatMap((id) => {
			const section = sections.find((item) => item.id === id);
			if (!section) return [];
			const text = `${section.label} ${group.label} ${group.detail} ${KEYWORDS[id] ?? ""}`.toLocaleLowerCase();
			return words.every((word) => text.includes(word)) ? [section] : [];
		}),
	})).filter((group) => group.sections.length > 0);
}
