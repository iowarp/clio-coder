export interface ReleaseVersionInput {
	version: unknown;
	changelog: unknown;
	releaseContext: boolean;
}

export declare function releaseVersionErrors(input: ReleaseVersionInput): string[];
