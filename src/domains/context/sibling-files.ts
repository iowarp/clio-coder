import { scanAgentConfigs } from "./adoption.js";

export interface SiblingContextFile {
	source: string;
	path: string;
	content: string;
}

export interface LoadSiblingContextFilesOptions {
	homeDir?: string;
	includeGlobal?: boolean;
}

export function loadSiblingContextFiles(
	cwd: string,
	options: LoadSiblingContextFilesOptions = {},
): SiblingContextFile[] {
	const scan = scanAgentConfigs({
		cwd,
		...(options.homeDir ? { homeDir: options.homeDir } : {}),
		includeGlobal: options.includeGlobal === true,
	});
	return scan.sources.map((source) => ({
		source: source.scope,
		path: source.path,
		content: source.content,
	}));
}
