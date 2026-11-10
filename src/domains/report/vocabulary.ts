/**
 * Closed vocabularies a report is built from. Every value here can reach a public issue, so each list is fixed in
 * source and nothing a caller writes is added to it.
 */

/** The one repository reports go to. No function takes a destination from a caller's text. */
export const REPORT_REPOSITORY = "iowarp/clio-coder";

export const REPORT_KINDS = ["bug", "feature", "question"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The `area:*` label suffixes the repository carries. */
export const REPORT_AREAS = [
	"acp",
	"api",
	"build",
	"cli",
	"context",
	"dispatch",
	"docs",
	"engine",
	"gui",
	"install",
	"memory",
	"providers",
	"safety",
	"skills",
	"telemetry",
	"tests",
	"tui",
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

export const REPORT_SURFACES = ["tui", "headless", "acp", "gui", "installer"] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

export const REPORT_TRIGGERS = ["operator", "agent", "crash", "internal", "repeated"] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

export const REPORT_OS = ["linux", "macos", "windows"] as const;
export type ReportOs = (typeof REPORT_OS)[number];

export const REPORT_INSTALL_KINDS = [
	"source",
	"npm",
	"pnpm",
	"bun",
	"installer",
	"homebrew",
	"winget",
	"local",
	"unknown",
] as const;
export type ReportInstallKind = (typeof REPORT_INSTALL_KINDS)[number];

export const REPORT_AUTONOMY = ["default", "yolo"] as const;
export type ReportAutonomy = (typeof REPORT_AUTONOMY)[number];

export function isOneOf<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
	return typeof value === "string" && (values as ReadonlyArray<string>).includes(value);
}

export function reportOs(platform: NodeJS.Platform = process.platform): ReportOs | null {
	return platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : null;
}

/** The fixed headings of a report body, matching the issue form's field labels where one exists. */
export const REPORT_HEADINGS = {
	happened: "What happened",
	operatorWords: "In the operator's words",
	expected: "Expected",
	reproduce: "Steps",
	observed: "What Clio observed",
	notKnown: "Not known",
	environment: "Environment",
} as const;

export const REPORT_BLOCK_TAG = "clio-coder-report";
export const REPORT_DETAILS_SUMMARY = "Report details";
export const REPORT_FOOTER =
	"Filed with `/report` from Clio Coder. The reporter reviewed this text before it was sent.";
export const REPORT_EMPTY_SECTION = "_No response_";
export const REPORT_NOTHING_OBSERVED = "Nothing recorded.";
export const REPORT_NOTHING_UNKNOWN = "nothing listed";
