export interface Options {
	label?: string;
	retries: number;
}
export type Mode = "fast" | "full";
export const describe = (options: Options): string => options.label ?? String(options.retries);
