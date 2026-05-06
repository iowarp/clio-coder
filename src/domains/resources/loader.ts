import { expandConfigPath } from "../../core/resolve-config-value.js";
import type { ResourceDiagnostic } from "./collision.js";
import {
	type LoadProjectContextFilesInput,
	loadProjectContextFiles,
	type ProjectContextFile,
	renderProjectContextFiles,
} from "./context-files/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourceLoaderOptions {
	cwd?: string;
	noContextFiles?: boolean;
}

export interface ResourcesLoader {
	contextFiles(cwd?: string, options?: Omit<LoadProjectContextFilesInput, "cwd">): ProjectContextFile[];
	renderContextFiles(files: ReadonlyArray<ProjectContextFile>, cwd?: string): string;
	skills(): ResourceList<never>;
	prompts(): ResourceList<never>;
	themes(): ResourceList<never>;
	resolvePath(value: string, cwd?: string): string;
	reload(): Promise<void>;
}

export function createResourcesLoader(options: ResourceLoaderOptions = {}): ResourcesLoader {
	const defaultCwd = options.cwd ?? process.cwd();
	const noContextFiles = options.noContextFiles === true;
	return {
		contextFiles(cwd = defaultCwd, contextOptions = {}) {
			if (noContextFiles) return [];
			return loadProjectContextFiles({ cwd, ...contextOptions });
		},
		renderContextFiles(files, cwd = defaultCwd) {
			return renderProjectContextFiles(files, cwd);
		},
		skills() {
			return { items: [], diagnostics: [] };
		},
		prompts() {
			return { items: [], diagnostics: [] };
		},
		themes() {
			return { items: [], diagnostics: [] };
		},
		resolvePath(value, cwd = defaultCwd) {
			return expandConfigPath(value, { cwd });
		},
		async reload() {
			return undefined;
		},
	};
}
