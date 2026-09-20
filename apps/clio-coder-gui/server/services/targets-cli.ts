import { Value } from "typebox/value";
import { CliTargets, Routing, type TargetOperationResult } from "../../contracts/targets-cli.js";
import type { CliRunner } from "./cli-runner.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { SettingsService } from "./settings.js";
import type { WorkspaceService } from "./workspaces.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AppProblem("operation_failed", "CLI returned an invalid inventory.");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 256)
		throw new AppProblem("operation_failed", "CLI returned an invalid inventory field.");
	return value;
}
const optionalText = (value: unknown) => (value === undefined || value === null ? null : text(value));
function items(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 100_000)
		throw new AppProblem("operation_failed", "CLI returned an invalid inventory collection.");
	return value;
}
function safeUrl(value: unknown) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol)) return null;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href.slice(0, 2048);
	} catch {
		return null;
	}
}
export function projectTargets(raw: unknown): CliTargets {
	const rows = items(object(raw).targets);
	const result = {
		targets: rows.slice(0, 200).map((value) => {
			const row = object(value),
				target = object(row.target),
				models = items(row.discoveredModels);
			const capabilities = object(row.capabilities),
				health = object(row.health);
			return {
				id: text(target.id),
				runtime: text(target.runtime),
				url: safeUrl(target.url),
				defaultModel: optionalText(target.defaultModel),
				available: row.available,
				health: text(health.status),
				tier: text(row.tier),
				models: models.slice(0, 200).map(text),
				modelsTruncated: models.length > 200,
				contextWindow:
					typeof capabilities.contextWindow === "number" && capabilities.contextWindow > 0
						? capabilities.contextWindow
						: null,
			};
		}),
		truncated: rows.length > 200,
	};
	if (!Value.Check(CliTargets, result))
		throw new AppProblem("operation_failed", "CLI returned an invalid target projection.");
	return result;
}
export class TargetsService {
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly settings: SettingsService,
		private readonly operations: OperationRegistry,
	) {}
	async list(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return projectTargets(await this.runner.run({ kind: "targets.list" }, workspace.path));
	}
	async mutate(workspaceId: string, id: string, action: "probe" | "use" | "remove", key: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.operations.create({
			kind: `targets.${action}`,
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, id, action }),
			cancellable: action === "probe",
			run: async (progress, signal): Promise<TargetOperationResult> => {
				progress(action === "probe" ? "Clio is probing configured targets." : "Clio is updating user target settings.");
				const result = await this.runner.run({ kind: `targets.${action}`, id }, workspace.path, signal);
				let targets: CliTargets;
				let settings: Awaited<ReturnType<SettingsService["settings"]>> | undefined;
				try {
					targets = action === "probe" ? projectTargets(result) : await this.list(workspaceId);
					if (action === "use") settings = await this.settings.settings(workspaceId);
				} catch (error) {
					if (action === "probe") throw error;
					throw new AppProblem(
						"operation_failed",
						"CLI mutation exited with code 0, but its follow-up read failed. Settings may already be changed; refresh before retrying.",
					);
				}
				return {
					kind: "targets",
					id,
					exitCode: 0,
					message: action === "probe" ? "Target probe completed." : "User target settings updated.",
					targets,
					...(settings ? { settings } : {}),
				};
			},
		});
	}
	async routing(workspaceId: string): Promise<Routing> {
		const workspace = await this.workspaces.get(workspaceId);
		const [rawModels, rawProfiles, rawBindings] = await Promise.all([
			this.runner.run({ kind: "routing.models" }, workspace.path),
			this.runner.run({ kind: "routing.profiles" }, workspace.path),
			this.runner.run({ kind: "routing.bindings" }, workspace.path),
		]);
		const models = items(rawModels),
			profiles = items(rawProfiles),
			bindings = items(rawBindings);
		const result = {
			models: models.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					target: text(row.targetId),
					runtime: text(row.runtimeId),
					id: row.modelId === "(no models)" ? null : optionalText(row.modelId),
					capabilities: text(row.caps),
					context: typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : null,
					maxOutputTokens: typeof row.maxTokens === "number" && row.maxTokens > 0 ? row.maxTokens : null,
					state: text(row.state),
				};
			}),
			profiles: profiles.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					name: text(row.name),
					target: optionalText(row.target),
					runtime: optionalText(row.runtime),
					model: optionalText(row.model),
					thinkingLevel: text(row.thinkingLevel),
				};
			}),
			bindings: bindings.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					agentId: text(row.agentId),
					profile: text(row.profile),
					target: optionalText(row.target),
					model: optionalText(row.model),
					resolved: row.warning === null,
				};
			}),
			truncated: models.length > 2000 || profiles.length > 2000 || bindings.length > 2000,
		};
		if (!Value.Check(Routing, result))
			throw new AppProblem("operation_failed", "CLI returned an invalid routing projection.");
		return result;
	}
}
