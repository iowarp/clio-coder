export const AREA_LABELS = {
	sessions: "Sessions",
	traces: "Traces",
	fleet: "Fleet",
	evidence: "Evidence",
	library: "Library",
	toolchain: "Toolchain",
	settings: "Settings",
	system: "System",
} as const;

export type NavigationArea = keyof typeof AREA_LABELS;

/** The URL owns the area, including direct links and browser Back/Forward. */
export function navigationArea(pathname: string): NavigationArea | null {
	const section = pathname.split("/")[1];
	if (section === "workspaces") return "sessions";
	return section && Object.hasOwn(AREA_LABELS, section) ? (section as NavigationArea) : null;
}
