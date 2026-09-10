import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseFleetContract, resolveFleetReferences } from "../agents/fleet-contract.js";
import { parseFrontmatter } from "../agents/frontmatter.js";
import { recipeIdFromPath } from "../agents/recipe.js";
import { parseAgentRecipeSchema } from "../agents/recipe-schema.js";
import { assertAgentSpecPolicy, normalizeAgentSpec } from "../agents/spec.js";
import { pluginResourcePath, readPluginManifest } from "../plugins/discovery.js";
import type { PluginCandidate } from "../plugins/types.js";
import { resolvePackageReferences } from "./package-references.js";
import { loadPromptTemplates, type PromptTemplateRoot } from "./prompts/loader.js";
import { loadSkills, type Skill, type SkillRoot, skillCatalogValidity } from "./skills/loader.js";

export type LibraryValidationSeverity = "warning" | "error";

export interface LibraryValidationDiagnostic {
	severity: LibraryValidationSeverity;
	code: string;
	message: string;
	path?: string | undefined;
	componentRef?: string | undefined;
	kind?: string | undefined;
}

export interface LibraryResourceValidationRecord {
	kind: string;
	name: string;
	path: string;
	componentRef?: string | undefined;
	/** Authored description when the resource parsed; body text is never carried. */
	description?: string | undefined;
	valid: boolean;
	diagnostics: LibraryValidationDiagnostic[];
}

export interface LibraryValidationPrerequisite {
	type: "command" | "agent" | "capability";
	identifier: string;
	description?: string | undefined;
	sourcePath?: string | undefined;
}

export interface LibraryPackageValidation {
	contentValid: boolean;
	resources: LibraryResourceValidationRecord[];
	diagnostics: LibraryValidationDiagnostic[];
	prerequisites: LibraryValidationPrerequisite[];
}

export interface LibraryPackageValidationResult extends PluginCandidate {
	manifestValid: boolean;
	validation: LibraryPackageValidation;
}

function normalizePathRel(root: string, targetPath: string): string {
	return path.relative(root, targetPath).split(path.sep).join("/");
}

function parseRefErrorCode(message: string, fallback: string): string {
	return message.includes("component reference") || message.includes("package path")
		? "ERR_PACKAGE_REFERENCE"
		: fallback;
}

export function validateLibraryPackage(
	packageRoot: string,
	_options: { cwd?: string } = {},
): LibraryPackageValidationResult {
	const resolved = path.resolve(packageRoot);
	const candidate = readPluginManifest(resolved);

	if (!candidate.valid || !candidate.manifest) {
		const manifestErrors: LibraryValidationDiagnostic[] = candidate.diagnostics.map((diag) => ({
			severity: diag.type === "error" ? "error" : "warning",
			code: "ERR_MANIFEST",
			message: diag.message,
			path: diag.path,
		}));
		return {
			...candidate,
			manifestValid: false,
			valid: false,
			validation: {
				contentValid: false,
				resources: [],
				diagnostics: manifestErrors,
				prerequisites: [],
			},
		};
	}

	const manifest = candidate.manifest;
	const packageKind = manifest.clio.kind ?? "plugin";
	const declaredResources = manifest.clio.resources ?? {};
	const declaredComponents = manifest.clio.components ?? [];

	const contentDiagnostics: LibraryValidationDiagnostic[] = [];
	const resources: LibraryResourceValidationRecord[] = [];
	const prerequisites: LibraryValidationPrerequisite[] = [];

	// ---------------------------------------------------------------------------
	// 1. Skills
	// ---------------------------------------------------------------------------
	const loadedSkills = new Map<string, Skill>();
	let skillRootDir: string | undefined;
	if (declaredResources.skills !== undefined || existsSync(path.join(resolved, "skills"))) {
		const relativeSkills = declaredResources.skills ?? "skills";
		try {
			skillRootDir = pluginResourcePath(resolved, relativeSkills, packageKind === "skill" && relativeSkills === ".");
			const skillRoot: SkillRoot = {
				path: skillRootDir,
				scope: "package",
				source: "plugin",
				rootPath: resolved,
				containment: resolved,
			};
			const skillList = loadSkills({ roots: [skillRoot], disableDiscovery: true, cwd: resolved });
			const validity = skillCatalogValidity(skillList);
			const loadedPaths = new Set(skillList.items.map((s) => s.filePath));

			if (!validity.ok) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_SKILL",
					message: `skill catalog invalid: ${validity.reason}`,
					path: skillRootDir,
					kind: "skill",
				});
			}

			for (const skill of skillList.items) {
				loadedSkills.set(skill.name, skill);
				const relPath = normalizePathRel(resolved, skill.filePath);
				const hasHardError = skill.diagnostics.some((d) => d.type === "error" || d.type === "collision");
				const skillDiags: LibraryValidationDiagnostic[] = skill.diagnostics.map((d) => ({
					severity: d.type === "error" || d.type === "collision" ? "error" : "warning",
					code: d.type === "error" || d.type === "collision" ? "ERR_SKILL" : "WARN_SKILL",
					message: d.message,
					path: d.path ?? skill.filePath,
					kind: "skill",
				}));
				for (const d of skillDiags) {
					if (d.severity === "error") contentDiagnostics.push(d);
				}
				resources.push({
					kind: "skill",
					name: skill.name,
					path: relPath,
					description: skill.description,
					valid: !hasHardError,
					diagnostics: skillDiags,
				});
			}

			for (const diag of skillList.diagnostics) {
				const isUnloadable = diag.path !== undefined && !loadedPaths.has(diag.path);
				const isHard = diag.type === "error" || diag.type === "collision" || isUnloadable;
				if (isHard) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_SKILL",
						message: diag.message,
						path: diag.path,
						kind: "skill",
					});
				}
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_SKILL",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, relativeSkills),
				kind: "skill",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 2. Prompts
	// ---------------------------------------------------------------------------
	if (declaredResources.prompts !== undefined) {
		try {
			const promptsDir = pluginResourcePath(resolved, declaredResources.prompts);
			const promptRoot: PromptTemplateRoot = {
				path: promptsDir,
				scope: "package",
				source: "plugin",
				plugin: true,
				trusted: true,
				rootPath: resolved,
			};
			const promptList = loadPromptTemplates({ roots: [promptRoot] });
			const loadedPromptPaths = new Set(promptList.items.map((p) => p.filePath));

			for (const template of promptList.items) {
				const relPath = normalizePathRel(resolved, template.filePath);
				const isUnavailable = template.unavailable !== undefined;
				const templateDiags: LibraryValidationDiagnostic[] = [];
				if (isUnavailable) {
					const diag: LibraryValidationDiagnostic = {
						severity: "error",
						code: "ERR_PROMPT",
						message: `prompt template /${template.name} cannot run: ${template.unavailable}`,
						path: template.filePath,
						kind: "prompt",
					};
					templateDiags.push(diag);
					contentDiagnostics.push(diag);
				}
				resources.push({
					kind: "prompt",
					name: template.name,
					path: relPath,
					description: template.description,
					valid: !isUnavailable,
					diagnostics: templateDiags,
				});
			}

			for (const diag of promptList.diagnostics) {
				const isDropped = diag.path !== undefined && !loadedPromptPaths.has(diag.path);
				const isHard = diag.type === "error" || diag.type === "collision" || isDropped;
				if (isHard) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_PROMPT",
						message: diag.message,
						path: diag.path,
						kind: "prompt",
					});
				}
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_PROMPT",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.prompts),
				kind: "prompt",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 3. Agents
	// ---------------------------------------------------------------------------
	if (declaredResources.agents !== undefined) {
		try {
			const agentsDir = pluginResourcePath(resolved, declaredResources.agents);
			let agentEntries: import("node:fs").Dirent[] = [];
			try {
				agentEntries = readdirSync(agentsDir, { withFileTypes: true });
			} catch (err) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_AGENT",
					message: `cannot read agents directory: ${err instanceof Error ? err.message : String(err)}`,
					path: agentsDir,
					kind: "agent",
				});
			}

			for (const entry of agentEntries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const filepath = path.join(agentsDir, entry.name);
				const relPath = normalizePathRel(resolved, filepath);
				const agentDiags: LibraryValidationDiagnostic[] = [];
				let recipeName = path.basename(entry.name, ".md");
				let recipeDescription: string | undefined;

				try {
					const id = recipeIdFromPath(filepath, agentsDir);
					recipeName = id;
					const raw = readFileSync(filepath, "utf8");
					const { frontmatter, body: rawBody } = parseFrontmatter(raw, filepath);
					const body = resolvePackageReferences(rawBody, { rootPath: resolved, plugin: true });
					const recipe = parseAgentRecipeSchema({ id, source: "plugin", filepath, body, frontmatter });
					recipeDescription = recipe.description;

					if (recipe.skills.length > 0) {
						if (packageKind === "agent") {
							agentDiags.push({
								severity: "error",
								code: "ERR_AGENT",
								message: `agent recipe: ${filepath}: standalone recipe cannot bind external skills; must declare skills: []`,
								path: filepath,
								kind: "agent",
							});
						} else if (!skillRootDir) {
							agentDiags.push({
								severity: "error",
								code: "ERR_AGENT",
								message: `agent recipe: ${filepath}: plugin declares bound skills but no skills resource root`,
								path: filepath,
								kind: "agent",
							});
						} else {
							const canonicalSkillRoot = realpathSync(skillRootDir);
							for (const skillName of recipe.skills) {
								const skill = loadedSkills.get(skillName);
								if (!skill?.trusted) {
									agentDiags.push({
										severity: "error",
										code: "ERR_AGENT",
										message: `agent recipe: ${filepath}: bound skill unavailable: ${skillName}`,
										path: filepath,
										kind: "agent",
									});
								} else {
									const canonicalSkill = realpathSync(skill.filePath);
									const relative = path.relative(canonicalSkillRoot, canonicalSkill);
									if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
										agentDiags.push({
											severity: "error",
											code: "ERR_AGENT",
											message: `agent recipe: ${filepath}: bound skill escapes its plugin: ${skill.filePath}`,
											path: filepath,
											kind: "agent",
										});
									}
								}
							}
						}
					}

					assertAgentSpecPolicy(normalizeAgentSpec(recipe));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					agentDiags.push({
						severity: "error",
						code: parseRefErrorCode(message, "ERR_AGENT"),
						message,
						path: filepath,
						kind: "agent",
					});
				}

				for (const d of agentDiags) contentDiagnostics.push(d);
				resources.push({
					kind: "agent",
					name: recipeName,
					path: relPath,
					...(recipeDescription !== undefined ? { description: recipeDescription } : {}),
					valid: agentDiags.length === 0,
					diagnostics: agentDiags,
				});
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_AGENT",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.agents),
				kind: "agent",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 4. Fleets
	// ---------------------------------------------------------------------------
	if (declaredResources.fleets !== undefined) {
		try {
			const fleetsDir = pluginResourcePath(resolved, declaredResources.fleets);
			let fleetEntries: import("node:fs").Dirent[] = [];
			try {
				fleetEntries = readdirSync(fleetsDir, { withFileTypes: true });
			} catch (err) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_FLEET",
					message: `cannot read fleets directory: ${err instanceof Error ? err.message : String(err)}`,
					path: fleetsDir,
					kind: "fleet",
				});
			}

			for (const entry of fleetEntries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const filepath = path.join(fleetsDir, entry.name);
				const relPath = normalizePathRel(resolved, filepath);
				const fleetDiags: LibraryValidationDiagnostic[] = [];
				let publicName = path.basename(entry.name, ".md");
				let fleetDescription: string | undefined;

				try {
					const raw = readFileSync(filepath, "utf8");
					const contract = parseFleetContract(raw, filepath);
					publicName = contract.name;
					fleetDescription = contract.description;
					const resolvedContract = resolveFleetReferences(contract, { source: "plugin", rootPath: resolved });

					for (const step of resolvedContract.steps) {
						if (step.kind === "code") {
							prerequisites.push({
								type: "command",
								identifier: step.command,
								sourcePath: filepath,
								description: `fleet step '${step.id}' requires command '${step.command}'`,
							});
						} else if (step.kind === "agent") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `fleet step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "plan") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `fleet plan step '${step.id}' requires agent '${step.agent}'`,
								});
							}
							for (const rosterAgent of step.roster) {
								const isLocalRoster = resources.some((r) => r.kind === "agent" && r.name === rosterAgent);
								if (!isLocalRoster) {
									prerequisites.push({
										type: "agent",
										identifier: rosterAgent,
										sourcePath: filepath,
										description: `fleet plan step '${step.id}' roster requires agent '${rosterAgent}'`,
									});
								}
							}
						} else if (step.kind === "gate") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `fleet gate step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "loop") {
							if (step.check.kind === "code") {
								prerequisites.push({
									type: "command",
									identifier: step.check.command,
									sourcePath: filepath,
									description: `fleet loop step '${step.id}' check requires command '${step.check.command}'`,
								});
							} else if (step.check.kind === "agent") {
								const checkAgent = step.check.agent;
								const isLocal = resources.some((r) => r.kind === "agent" && r.name === checkAgent);
								if (!isLocal) {
									prerequisites.push({
										type: "agent",
										identifier: checkAgent,
										sourcePath: filepath,
										description: `fleet loop step '${step.id}' check requires agent '${checkAgent}'`,
									});
								}
							}
							const repairAgent = step.repair.agent;
							const isLocalRepair = resources.some((r) => r.kind === "agent" && r.name === repairAgent);
							if (!isLocalRepair) {
								prerequisites.push({
									type: "agent",
									identifier: step.repair.agent,
									sourcePath: filepath,
									description: `fleet loop step '${step.id}' repair requires agent '${step.repair.agent}'`,
								});
							}
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					fleetDiags.push({
						severity: "error",
						code: parseRefErrorCode(message, "ERR_FLEET"),
						message,
						path: filepath,
						kind: "fleet",
					});
				}

				for (const d of fleetDiags) contentDiagnostics.push(d);
				resources.push({
					kind: "fleet",
					name: publicName,
					path: relPath,
					...(fleetDescription !== undefined ? { description: fleetDescription } : {}),
					valid: fleetDiags.length === 0,
					diagnostics: fleetDiags,
				});
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_FLEET",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.fleets),
				kind: "fleet",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 5. Component verification and omission detection
	// ---------------------------------------------------------------------------
	for (const comp of declaredComponents) {
		const componentRef = `${comp.kind}:${comp.id}`;
		let fullCompPath: string;
		try {
			fullCompPath = pluginResourcePath(resolved, comp.path);
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_COMPONENT",
				message: `component ${componentRef} path invalid: ${err instanceof Error ? err.message : String(err)}`,
				path: path.join(resolved, comp.path),
				componentRef,
				kind: comp.kind,
			});
			continue;
		}

		const normalizedCompPath = normalizePathRel(resolved, fullCompPath);

		if (["agent", "fleet", "skill", "prompt"].includes(comp.kind)) {
			if (comp.kind === "agent") {
				const agentsDir = declaredResources.agents ? pluginResourcePath(resolved, declaredResources.agents) : null;
				if (agentsDir && path.dirname(fullCompPath) !== agentsDir) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_COMPONENT",
						message: `component agent:${comp.id} at ${comp.path} is nested and cannot be discovered by runtime loader`,
						path: fullCompPath,
						componentRef,
						kind: "agent",
					});
				}
			} else if (comp.kind === "fleet") {
				const fleetsDir = declaredResources.fleets ? pluginResourcePath(resolved, declaredResources.fleets) : null;
				if (fleetsDir && path.dirname(fullCompPath) !== fleetsDir) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_COMPONENT",
						message: `component fleet:${comp.id} at ${comp.path} is nested and cannot be discovered by runtime loader`,
						path: fullCompPath,
						componentRef,
						kind: "fleet",
					});
				}
			}

			const matched = resources.find((r) => r.path === normalizedCompPath && r.kind === comp.kind);
			if (!matched) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_COMPONENT",
					message: `component ${componentRef} declared in manifest was not successfully loaded from ${comp.path}`,
					path: fullCompPath,
					componentRef,
					kind: comp.kind,
				});
			} else {
				matched.componentRef = componentRef;
			}
		} else {
			const exists = existsSync(fullCompPath) && statSync(fullCompPath).isFile();
			const diags: LibraryValidationDiagnostic[] = exists
				? []
				: [
						{
							severity: "error",
							code: "ERR_COMPONENT",
							message: `ancillary component ${componentRef} file does not exist: ${comp.path}`,
							path: fullCompPath,
							componentRef,
							kind: comp.kind,
						},
					];
			for (const d of diags) contentDiagnostics.push(d);
			resources.push({
				kind: comp.kind,
				name: comp.id,
				path: normalizedCompPath,
				componentRef,
				valid: exists,
				diagnostics: diags,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 6. Themes
	// ---------------------------------------------------------------------------
	if (declaredResources.themes !== undefined) {
		const themesDir = pluginResourcePath(resolved, declaredResources.themes);
		const exists = existsSync(themesDir) && statSync(themesDir).isDirectory();
		resources.push({
			kind: "theme",
			name: path.basename(themesDir),
			path: normalizePathRel(resolved, themesDir),
			valid: exists,
			diagnostics: exists
				? []
				: [
						{
							severity: "error",
							code: "ERR_THEME",
							message: `declared themes resource root directory does not exist: ${declaredResources.themes}`,
							path: themesDir,
							kind: "theme",
						},
					],
		});
	}

	const contentValid = !contentDiagnostics.some((d) => d.severity === "error");
	const valid = true && contentValid;

	return {
		...candidate,
		manifestValid: true,
		valid,
		validation: {
			contentValid,
			resources,
			diagnostics: contentDiagnostics,
			prerequisites,
		},
	};
}
