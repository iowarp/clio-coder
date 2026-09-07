export interface ReleaseVersionInput {
	version: unknown;
	changelog: unknown;
	releaseContext: boolean;
}

export declare function releaseVersionErrors(input: ReleaseVersionInput): string[];

export declare function readmeInstallVersion(input: { version: string; changelog: string }): string;
