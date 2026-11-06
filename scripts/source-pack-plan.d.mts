export declare function extensionTypeSeeds(root: string): string[];
export declare function typeImportClosure(root: string, seeds: ReadonlyArray<string>): string[];
export declare function planSourcePack(root: string): { loose: string[]; packed: string[]; closure: string[] };
export declare function readSourcePackMembers(packFile: string): string[];
