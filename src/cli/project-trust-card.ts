import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	captureProjectSurface,
	type ProjectSurfaceSnapshot,
	type ProjectTrustSurface,
	projectPackageEntries,
	recordProjectPackageTrust,
	recordProjectSurfaceTrust,
} from "../core/workspace-trust.js";
import { loadUserHooks, type UserHookDeclarationBatch } from "../domains/middleware/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { loadProjectSafetyPolicy } from "../domains/safety/project-policy.js";
import { canSelect, promptSelect, type SelectResult } from "./select.js";

const CARD_SURFACES: ReadonlyArray<ProjectTrustSurface> = ["settings", "safety", "hooks", "extensions", "plugins"];

export interface ProjectTrustCardSurface {
	surface: ProjectTrustSurface;
	changed: boolean;
	summary: string[];
	snapshot: ProjectSurfaceSnapshot;
}

export interface ProjectTrustCardModel {
	workspaceRoot: string;
	surfaces: ProjectTrustCardSurface[];
}

const clean = (value: unknown): string => sanitizeCallTargetText(String(value));

function parsedFiles(snapshot: ProjectSurfaceSnapshot): unknown[] {
	return snapshot.files.flatMap((file) => {
		if (file.text === null) return [];
		try {
			return [parseYaml(file.text) as unknown];
		} catch {
			return [undefined];
		}
	});
}

function settingsSummary(snapshot: ProjectSurfaceSnapshot): string[] {
	const areas = new Set<string>();
	const connections: string[] = [];
	for (const blob of parsedFiles(snapshot)) {
		if (blob === null || typeof blob !== "object" || Array.isArray(blob)) continue;
		for (const [key, value] of Object.entries(blob)) {
			areas.add(clean(key));
			if (key !== "targets" || !Array.isArray(value)) continue;
			for (const target of value) {
				if (target === null || typeof target !== "object") continue;
				const { id, url } = target as { id?: unknown; url?: unknown };
				if (typeof url === "string") connections.push(`connection ${clean(id ?? "(unnamed)")} → ${clean(url)}`);
			}
		}
	}
	return [`areas: ${areas.size > 0 ? [...areas].join(", ") : "(none)"}`, ...connections];
}

function safetySummary(workspaceRoot: string): string[] {
	const policy = loadProjectSafetyPolicy(workspaceRoot);
	const paths = policy.pathPolicy as Record<string, unknown>;
	const blocks = Object.values(paths).reduce<number>((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
	return [
		`${blocks} path block rule${blocks === 1 ? "" : "s"}, ${policy.commands.length} command allow rule${policy.commands.length === 1 ? "" : "s"}`,
		...policy.errors.slice(0, 2).map(clean),
	];
}

function hooksSummary(snapshot: ProjectSurfaceSnapshot): string[] {
	const batches: UserHookDeclarationBatch[] = [];
	for (const [index, file] of snapshot.files.entries()) {
		if (file.text === null) continue;
		let declarations: unknown = [];
		try {
			declarations = parseYaml(file.text) ?? [];
		} catch {
			return [`cannot parse ${clean(file.path)}`];
		}
		batches.push({
			source:
				index === 0
					? { origin: "project", sourcePath: ".clio-coder/hooks.yaml" }
					: { origin: "project.local", sourcePath: ".clio-coder/hooks.local.yaml" },
			declarations,
		});
	}
	const loaded = loadUserHooks(batches, { workspaceRoot: snapshot.workspaceRoot });
	const lines = loaded.hooks.map((hook) =>
		hook.spec.kind === "command"
			? `${clean(hook.on)}: runs ${clean(hook.spec.argv.join(" "))}`
			: `${clean(hook.on)}: ${hook.spec.kind} ${clean(hook.id)}`,
	);
	for (const issue of loaded.issues) lines.push(`not loaded: ${clean(issue.issues.join("; "))}`);
	for (const script of snapshot.scripts ?? [])
		lines.push(`script: ${clean(relative(snapshot.workspaceRoot, script.path))}`);
	return lines.length > 0 ? lines : ["(no hooks)"];
}

function packageSummary(snapshot: ProjectSurfaceSnapshot): string[] {
	const entries = projectPackageEntries(snapshot);
	if (entries === null) return ["install state cannot be parsed"];
	return entries.length > 0 ? [entries.map((entry) => clean(entry.id)).join(", ")] : ["(none)"];
}

/** Every gated project surface that has files and is not trusted, summarised by the parser that loads it. */
export function buildProjectTrustCard(cwd: string): ProjectTrustCardModel | null {
	const surfaces: ProjectTrustCardSurface[] = [];
	let workspaceRoot = cwd;
	for (const surface of CARD_SURFACES) {
		const snapshot = captureProjectSurface(cwd, surface);
		if (snapshot.verdict === "trusted") continue;
		if (!snapshot.files.some((file) => file.text !== null || file.error !== undefined)) continue;
		workspaceRoot = snapshot.workspaceRoot;
		const summary =
			surface === "settings"
				? settingsSummary(snapshot)
				: surface === "safety"
					? safetySummary(snapshot.workspaceRoot)
					: surface === "hooks"
						? hooksSummary(snapshot)
						: packageSummary(snapshot);
		surfaces.push({ surface, changed: snapshot.verdict === "changed", summary, snapshot });
	}
	return surfaces.length > 0 ? { workspaceRoot, surfaces } : null;
}

export function renderProjectTrustCard(model: ProjectTrustCardModel): string[] {
	const lines = ["", "This repository has its own Clio configuration.", `  ${clean(model.workspaceRoot)}`, ""];
	for (const item of model.surfaces) {
		lines.push(`  ${item.surface}${item.changed ? " (changed since you trusted it)" : ""}`);
		for (const line of item.summary) lines.push(`    ${line}`);
	}
	lines.push("", "It applies only after you trust it. Review shows each file in full.", "");
	return lines;
}

/** Writes the same records `config trust <surface> --hash <digest>` writes for each reviewed snapshot. */
export function trustProjectCard(model: ProjectTrustCardModel): void {
	for (const { surface, snapshot } of model.surfaces) {
		if (snapshot.contentHash === null) throw new Error(`project ${surface} cannot be read, so it cannot be trusted`);
		if (surface === "extensions" || surface === "plugins") recordProjectPackageTrust(snapshot);
		else recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
	}
}

/** What Review prints: every captured file, and for hooks the scripts its approval pins. */
export function projectTrustCardReviewFiles(model: ProjectTrustCardModel): Array<{ path: string; text: string }> {
	return model.surfaces.flatMap(({ snapshot }) =>
		[...snapshot.files, ...(snapshot.scripts ?? [])].flatMap((file) =>
			file.text === null ? [] : [{ path: file.path, text: file.text }],
		),
	);
}

/** One reviewed file as display lines: control sequences neutralized, indentation kept. */
export function projectTrustCardReviewLines(file: { path: string; text: string }): string[] {
	return [
		`── ${clean(file.path)}`,
		...file.text.split(/\r?\n/).map((line) => `${/^[ \t]*/.exec(line)?.[0] ?? ""}${clean(line)}`),
	];
}

export type ProjectTrustCardOutcome = "trusted" | "skipped" | "quit" | "none";

type CardChoice = "review" | "trust" | "skip";

/** `q` and Ctrl+C quit as the card's legend says; Esc keeps opening without the configuration. */
export function projectTrustCardChoice(result: SelectResult<CardChoice>): CardChoice | "quit" {
	if (result.kind === "selected") return result.value;
	return result.kind === "quit" ? "quit" : "skip";
}

/** One card before the session starts; Review is the default action. */
export async function runProjectTrustCard(cwd: string = process.cwd()): Promise<ProjectTrustCardOutcome> {
	const model = buildProjectTrustCard(cwd);
	if (model === null || !canSelect()) return "none";
	let reviewed = false;
	while (true) {
		const result = await promptSelect<CardChoice>({
			heading: renderProjectTrustCard(model),
			choices: [
				{ value: "review", label: reviewed ? "Review again" : "Review" },
				{ value: "trust", label: "Trust all" },
				{ value: "skip", label: "Open without it" },
			],
			initialIndex: reviewed ? 1 : 0,
			clearOnExit: true,
		});
		const choice = projectTrustCardChoice(result);
		if (choice === "quit") return "quit";
		if (choice === "skip") return "skipped";
		if (choice === "trust") {
			try {
				trustProjectCard(model);
				return "trusted";
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				return "skipped";
			}
		}
		reviewed = true;
		for (const file of projectTrustCardReviewFiles(model)) {
			process.stdout.write(`\n${projectTrustCardReviewLines(file).join("\n")}\n`);
		}
	}
}
