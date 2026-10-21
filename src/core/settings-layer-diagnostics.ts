import type { LayeredSettings, SettingsLayerIssue } from "./settings-layers.js";

export function formatSettingsLayerIssue(layered: LayeredSettings, issue: SettingsLayerIssue): string {
	const file = layered.layers.find((layer) => layer.origin === issue.origin)?.path ?? issue.origin;
	const detail = issue.message.startsWith(`${file}: `) ? issue.message.slice(file.length + 2) : issue.message;
	// Y7: YAML excerpts span several lines and would overwrite a running TUI.
	const firstLine = detail.split(/\r?\n/, 1)[0] ?? detail;
	const location = / at line (\d+), column (\d+):?$/.exec(firstLine);
	const message = location ? firstLine.slice(0, location.index) : firstLine;
	const key = issue.path === "(root)" || issue.path === file ? "" : `${issue.path}: `;
	return `${file}${location ? `:${location[1]}:${location[2]}` : ""}: ${key}${message}`;
}

export function formatSettingsLayerWarning(layered: LayeredSettings): string | null {
	// Y7: trust notices already explain why unapproved project bytes stay inert.
	const ignoredOrigins = new Set(
		layered.issues
			.filter((issue) => issue.message.includes("project settings ignored. Review with clio-coder config trust settings."))
			.map((issue) => issue.origin),
	);
	const issues = layered.issues.filter(
		(issue) => (issue.origin === "project" || issue.origin === "project.local") && !ignoredOrigins.has(issue.origin),
	);
	return issues.length === 0
		? null
		: `[clio-coder:config] ${issues.map((issue) => formatSettingsLayerIssue(layered, issue)).join("; ")}; continuing with valid settings`;
}
