export declare const REPOSITORY_ENV: string[];
export declare function directImports(file: string, text: string): string[];
export declare function selectLaneTests(input: {
	changed: string[];
	added: string[];
	importsOf: Map<string, string[]>;
	lists: { coreTests: string[]; guiTests: string[]; packageTests: string[] };
}): { affected: string[]; unlisted: string[] };
export declare function formatOpenapi(text: string): { status: number | null; stdout: string; stderr: string };
