import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { InteropAgentKind, InteropInventory, InteropInventoryItem, InteropResourceKind } from "./types.js";

const MAX_FILES = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
export function inventoryText(file: string): string {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("not a bounded regular file");
	return readFileSync(file, "utf8");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only declared configuration/resource roots; never sessions, history or executable modules. */
export function discoverInteropInventory(
	kind: InteropAgentKind,
	home: string,
	cwd: string,
	env: NodeJS.ProcessEnv = {},
): InteropInventory {
	const layout = kind.inventory;
	const result: InteropInventory = { status: "known", items: [], diagnostics: [], listing: "unknown" };
	if (!layout) return { ...result, status: "unknown", diagnostics: ["Inventory is not extended for this host."] };
	const seen = new Set<string>();
	let visited = 0;
	const unknown = (message: string): void => {
		result.status = "unknown";
		result.diagnostics.push(message);
	};
	const entries = (dir: string): string[] => {
		try {
			if (lstatSync(dir).isSymbolicLink()) {
				unknown(`Symbolic-link root was not traversed: ${dir}`);
				return [];
			}
			return readdirSync(dir).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown(`Cannot inspect ${dir}`);
			return [];
		}
	};
	const json = (file: string): Record<string, unknown> | undefined => {
		try {
			const value: unknown = JSON.parse(inventoryText(file));
			if (!object(value)) throw new Error("not object");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown(`Cannot parse ${file}`);
			return undefined;
		}
	};
	const add = (
		file: string,
		resourceKind: InteropResourceKind,
		scope: "user" | "project",
		plugin?: string,
		metadata: Partial<InteropInventoryItem> = {},
	): void => {
		const key = `${scope}:${resourceKind}:${file}:${metadata.name ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		let declaredName: string | undefined;
		if (["skill", "agent", "prompt"].includes(resourceKind)) {
			try {
				const raw = inventoryText(file);
				const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
				const data: unknown = file.endsWith(".toml")
					? parseToml(raw)
					: frontmatter
						? parseYaml(frontmatter[1] ?? "")
						: undefined;
				if (object(data) && typeof data.name === "string") declaredName = data.name;
			} catch {
				unknown(`Resource metadata is unknown: ${file}`);
			}
		}
		result.items.push({
			kind: resourceKind,
			name:
				declaredName ??
				(resourceKind === "skill" ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))),
			path: file,
			scope,
			...(plugin ? { plugin } : {}),
			...metadata,
		});
	};
	const walk = (dir: string, visit: (file: string) => void, depth = 0): void => {
		if (depth > 12) {
			unknown(`Depth limit reached: ${dir}`);
			return;
		}
		for (const name of entries(dir)) {
			if (++visited > MAX_FILES) {
				unknown("Inventory file limit reached.");
				return;
			}
			const file = path.join(dir, name);
			try {
				const stat = lstatSync(file);
				if (stat.isSymbolicLink()) {
					unknown(`Symbolic link was not traversed: ${file}`);
					continue;
				}
				if (stat.isDirectory()) walk(file, visit, depth + 1);
				else if (stat.isFile()) visit(file);
			} catch {
				unknown(`Cannot inspect ${file}`);
			}
		}
	};
	const scan = (
		root: string,
		scope: "user" | "project",
		plugin?: string,
		declarations = layout.declarations,
		resourceRoots = layout.roots,
	): void => {
		for (const entry of resourceRoots) {
			walk(path.join(root, entry.path), (file) => {
				if (
					entry.kind === "skill" ? path.basename(file) === "SKILL.md" : entry.extensions.some((ext) => file.endsWith(ext))
				)
					add(file, entry.kind, scope, plugin);
			});
		}
		for (const entry of declarations) {
			const file = path.join(root, entry.path);
			if (entry.path.endsWith(".toml")) {
				try {
					const data = parseToml(inventoryText(file));
					if (object(data.mcp_servers))
						for (const name of Object.keys(data.mcp_servers)) add(file, "mcp", scope, plugin, { name });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown(`Cannot read ${file}`);
				}
			} else {
				const data = json(file);
				if (!data) continue;
				const value = entry.key ? data[entry.key] : data;
				if (value === undefined) continue;
				if (object(value))
					for (const name of Object.keys(value)) {
						// Configuration values can carry credentials; inventory stores names only.
						const key = `${scope}:${entry.kind}:${file}:${name}`;
						if (!seen.has(key)) {
							seen.add(key);
							result.items.push({ kind: entry.kind, name, path: file, scope, ...(plugin ? { plugin } : {}) });
						}
					}
				else unknown(`Unsupported declaration shape in ${file}`);
			}
		}
	};

	scan(home, "user", undefined, layout.userDeclarations ?? [], []);
	scan(cwd, "project", undefined, layout.projectDeclarations ?? [], []);
	if (layout.projectModuleConfig) {
		const file = path.join(cwd, layout.projectModuleConfig);
		const data = json(file);
		if (Array.isArray(data?.plugin))
			for (const value of data.plugin) {
				const name =
					typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
				if (name)
					add(file, "executable", "project", undefined, {
						name: name.startsWith("file:") || path.isAbsolute(name) ? path.basename(name) : name,
					});
				else unknown("Unsupported project executable plugin declaration.");
			}
	}
	const userRoot =
		env[layout.homeEnv ?? ""] ??
		(layout.xdgConfigSubdir && env.XDG_CONFIG_HOME
			? path.join(env.XDG_CONFIG_HOME, layout.xdgConfigSubdir)
			: path.join(home, layout.userRoot));
	const roots: Array<{ root: string; scope: "user" | "project" }> = [
		{ root: userRoot, scope: "user" },
		...(layout.additionalUserRoots ?? []).map((root) => ({ root: path.join(home, root), scope: "user" as const })),
		...layout.projectRoots.map((root) => ({ root: path.join(cwd, root), scope: "project" as const })),
	];
	const pluginRoots = new Set<string>();
	const plugin = (root: string, scope: "user" | "project", metadata: Partial<InteropInventoryItem> = {}): void => {
		if (pluginRoots.has(`${scope}:${root}`)) return;
		pluginRoots.add(`${scope}:${root}`);
		let manifest: Record<string, unknown> | undefined;
		for (const manifestPath of layout.pluginManifests) {
			manifest = json(path.join(root, manifestPath));
			if (manifest) break;
		}
		add(root, "plugin", scope, undefined, {
			name: typeof manifest?.name === "string" ? manifest.name : path.basename(root),
			version: typeof manifest?.version === "string" ? manifest.version : "unknown",
			marketplace: "unknown",
			installation: "unknown",
			...metadata,
		});
		scan(root, scope, root);
		for (const directory of ["scripts", "tools"])
			walk(path.join(root, directory), (file) => add(file, "executable", scope, root));
	};
	for (const { root, scope } of roots) {
		scan(root, scope);
		if (layout.moduleConfig) {
			const data = json(path.join(root, layout.moduleConfig));
			if (Array.isArray(data?.plugin))
				for (const name of data.plugin) {
					const source =
						typeof name === "string" ? name : Array.isArray(name) && typeof name[0] === "string" ? name[0] : undefined;
					if (source)
						add(path.join(root, layout.moduleConfig), "executable", scope, undefined, {
							name: path.isAbsolute(source)
								? path.basename(source)
								: source.startsWith("file:")
									? path.basename(source)
									: source,
						});
					else unknown("Unsupported executable plugin declaration.");
				}
		}
		if (layout.settingsRegistry === "copilot") {
			const settings = json(path.join(root, "settings.json"));
			if (object(settings?.enabledPlugins))
				for (const [id, enabled] of Object.entries(settings.enabledPlugins)) {
					const [name, market] = id.split("@");
					const markets = settings.extraKnownMarketplaces;
					const entry = object(markets) && market ? markets[market] : undefined;
					const source = object(entry) ? entry.source : undefined;
					if (!name || !object(source) || source.source !== "directory" || typeof source.path !== "string") {
						unknown(`Plugin source path is unknown: ${id}`);
						add(path.join(root, "settings.json"), "plugin", scope, undefined, {
							name: id,
							installation: "installed",
							marketplace: market ?? "unknown",
							version: "unknown",
						});
						continue;
					}
					const marketManifest =
						json(path.join(source.path, ".claude-plugin/marketplace.json")) ??
						json(path.join(source.path, "marketplace.json"));
					const declaration = Array.isArray(marketManifest?.plugins)
						? marketManifest.plugins.find((entry) => object(entry) && entry.name === name)
						: undefined;
					if (!object(declaration) || typeof declaration.source !== "string" || !declaration.source.startsWith(".")) {
						unknown(`Plugin local source is unknown: ${id}`);
						continue;
					}
					plugin(path.resolve(source.path, declaration.source), scope, {
						name,
						marketplace: market ?? "unknown",
						installation: "installed",
						...(typeof enabled === "boolean" ? { enabled } : {}),
					});
				}
		}

		if (layout.installedRegistry) {
			const data = json(path.join(root, layout.installedRegistry));
			if (object(data?.plugins)) {
				for (const [id, records] of Object.entries(data.plugins)) {
					if (!Array.isArray(records)) {
						unknown("Unsupported installed plugin registry record.");
						continue;
					}
					for (const record of records) {
						if (!object(record) || typeof record.installPath !== "string") {
							unknown("Plugin install path is unknown.");
							continue;
						}
						if (record.scope !== "user" && record.scope !== "project" && record.scope !== "local") {
							unknown("Plugin scope is unknown.");
							continue;
						}
						if (record.scope !== "user" && record.projectPath !== cwd) continue;
						plugin(record.installPath, record.scope === "user" ? "user" : "project", {
							name: id.split("@")[0] ?? id,
							marketplace: id.split("@")[1] ?? "unknown",
							version: typeof record.version === "string" ? record.version : "unknown",
							installation: "installed",
						});
					}
				}
			}
		}
		for (const directory of layout.pluginDirs) {
			// Disk caches establish available content, not activation or installation status.
			const search = (dir: string, depth: number): void => {
				if (depth > 4) {
					unknown(`Plugin search depth reached: ${dir}`);
					return;
				}
				const names = entries(dir);
				if (
					layout.pluginManifests.some((name) => {
						try {
							return lstatSync(path.join(dir, name)).isFile();
						} catch {
							return false;
						}
					})
				) {
					const relative = path.relative(path.join(root, directory), dir).split(path.sep);
					plugin(dir, scope, layout.cacheMarketplace ? { marketplace: relative[0] ?? "unknown" } : {});
					return;
				}
				for (const name of names) {
					if (++visited > MAX_FILES) {
						unknown("Inventory file limit reached.");
						return;
					}
					try {
						if (lstatSync(path.join(dir, name)).isDirectory()) search(path.join(dir, name), depth + 1);
					} catch {
						unknown(`Cannot inspect ${dir}`);
					}
				}
			};
			search(path.join(root, directory), 0);
		}
	}
	if (layout.settingsRegistry === "codex") {
		try {
			const data = parseToml(inventoryText(path.join(userRoot, "config.toml")));
			if (object(data.plugins))
				for (const item of result.items.filter((item) => item.kind === "plugin" && item.scope === "user")) {
					const state = data.plugins[`${item.name}@${item.marketplace}`];
					if (object(state) && typeof state.enabled === "boolean") {
						item.enabled = state.enabled;
						item.installation = "installed";
					}
				}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown("Cannot parse Codex plugin settings.");
		}
	}
	if (layout.settingsRegistry === "antigravity") {
		const manifest = json(path.join(userRoot, "import_manifest.json"));
		if (Array.isArray(manifest?.imports))
			for (const item of result.items.filter((item) => item.kind === "plugin")) {
				if (manifest.imports.some((entry) => object(entry) && entry.name === item.name)) item.installation = "installed";
			}
	}

	return result;
}
