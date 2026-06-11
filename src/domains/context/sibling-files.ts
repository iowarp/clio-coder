export interface SiblingContextFile {
	source: string;
	path: string;
	content: string;
}

export interface LoadSiblingContextFilesOptions {
	homeDir?: string;
	includeGlobal?: boolean;
}
