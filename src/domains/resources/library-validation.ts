import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../agents/frontmatter.js";
import { parsePlaybook, resolvePlaybookReferences } from "../agents/playbook.js";
import { recipeIdFromPath } from "../agents/recipe.js";
import { parseAgentRecipeSchema } from "../agents/recipe-schema.js";
import { assertAgentSpecPolicy, normalizeAgentSpec } from "../agents/spec.js";
import { loadManifestFromRoot } from "../extensions/index.js";
import { pluginResourcePath } from "../plugins/discovery.js";
import type { PluginCandidate } from "../plugins/types.js";
import { readLibraryManifest } from "./library-packages.js";
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

export interface LibraryComponentValidationRecord {
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
	resources: LibraryComponentValidationRecord[];
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
	const candidate = readLibraryManifest(resolved);

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
	const resources: LibraryComponentValidationRecord[] = [];
	const prerequisites: LibraryValidationPrerequisite[] = [];

	if (packageKind === "extension" || existsSync(path.join(resolved, "clio-coder-extension.yaml"))) {
		const facet = loadManifestFromRoot(resolved);
		for (const diagnostic of facet.diagnostics)
			contentDiagnostics.push({
				severity: diagnostic.type === "error" ? "error" : "warning",
				code: "ERR_EXTENSION",
				message: diagnostic.message,
				path: diagnostic.path,
				kind: "extension",
			});
		if (facet.manifest)
			resources.push({
				kind: "extension",
				name: facet.manifest.id,
				path: path.relative(resolved, facet.manifestPath ?? resolved),
				description: facet.manifest.description,
				valid: facet.valid,
				diagnostics: [],
			});
	}

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
								message: `agent: ${filepath}: a standalone agent cannot bind external skills; must declare skills: []`,
								path: filepath,
								kind: "agent",
							});
						} else if (!skillRootDir) {
							agentDiags.push({
								severity: "error",
								code: "ERR_AGENT",
								message: `agent: ${filepath}: plugin declares bound skills but no skills resource root`,
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
										message: `agent: ${filepath}: bound skill unavailable: ${skillName}`,
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
											message: `agent: ${filepath}: bound skill escapes its plugin: ${skill.filePath}`,
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
	// 4. Playbooks
	// ---------------------------------------------------------------------------
	if (declaredResources.playbooks !== undefined) {
		try {
			const playbooksDir = pluginResourcePath(resolved, declaredResources.playbooks);
			let playbookEntries: import("node:fs").Dirent[] = [];
			try {
				playbookEntries = readdirSync(playbooksDir, { withFileTypes: true });
			} catch (err) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_PLAYBOOK",
					message: `cannot read playbooks directory: ${err instanceof Error ? err.message : String(err)}`,
					path: playbooksDir,
					kind: "playbook",
				});
			}

			for (const entry of playbookEntries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const filepath = path.join(playbooksDir, entry.name);
				const relPath = normalizePathRel(resolved, filepath);
				const playbookDiags: LibraryValidationDiagnostic[] = [];
				let publicName = path.basename(entry.name, ".md");
				let playbookDescription: string | undefined;

				try {
					const raw = readFileSync(filepath, "utf8");
					const playbook = parsePlaybook(raw, filepath);
					publicName = playbook.name;
					playbookDescription = playbook.description;
					const resolvedPlaybook = resolvePlaybookReferences(playbook, { source: "plugin", rootPath: resolved });

					for (const step of resolvedPlaybook.steps) {
						if (step.kind === "code") {
							prerequisites.push({
								type: "command",
								identifier: step.command,
								sourcePath: filepath,
								description: `playbook step '${step.id}' requires command '${step.command}'`,
							});
						} else if (step.kind === "agent") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `playbook step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "plan") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `playbook plan step '${step.id}' requires agent '${step.agent}'`,
								});
							}
							for (const rosterAgent of step.roster) {
								const isLocalRoster = resources.some((r) => r.kind === "agent" && r.name === rosterAgent);
								if (!isLocalRoster) {
									prerequisites.push({
										type: "agent",
										identifier: rosterAgent,
										sourcePath: filepath,
										description: `playbook plan step '${step.id}' roster requires agent '${rosterAgent}'`,
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
									description: `playbook gate step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "loop") {
							if (step.check.kind === "code") {
								prerequisites.push({
									type: "command",
									identifier: step.check.command,
									sourcePath: filepath,
									description: `playbook loop step '${step.id}' check requires command '${step.check.command}'`,
								});
							} else if (step.check.kind === "agent") {
								const checkAgent = step.check.agent;
								const isLocal = resources.some((r) => r.kind === "agent" && r.name === checkAgent);
								if (!isLocal) {
									prerequisites.push({
										type: "agent",
										identifier: checkAgent,
										sourcePath: filepath,
										description: `playbook loop step '${step.id}' check requires agent '${checkAgent}'`,
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
									description: `playbook loop step '${step.id}' repair requires agent '${step.repair.agent}'`,
								});
							}
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					playbookDiags.push({
						severity: "error",
						code: parseRefErrorCode(message, "ERR_PLAYBOOK"),
						message,
						path: filepath,
						kind: "playbook",
					});
				}

				for (const d of playbookDiags) contentDiagnostics.push(d);
				resources.push({
					kind: "playbook",
					name: publicName,
					path: relPath,
					...(playbookDescription !== undefined ? { description: playbookDescription } : {}),
					valid: playbookDiags.length === 0,
					diagnostics: playbookDiags,
				});
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_PLAYBOOK",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.playbooks),
				kind: "playbook",
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

		if (["agent", "playbook", "skill", "prompt"].includes(comp.kind)) {
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
			} else if (comp.kind === "playbook") {
				const playbooksDir = declaredResources.playbooks ? pluginResourcePath(resolved, declaredResources.playbooks) : null;
				if (playbooksDir && path.dirname(fullCompPath) !== playbooksDir) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_COMPONENT",
						message: `component playbook:${comp.id} at ${comp.path} is nested and cannot be discovered by runtime loader`,
						path: fullCompPath,
						componentRef,
						kind: "playbook",
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
