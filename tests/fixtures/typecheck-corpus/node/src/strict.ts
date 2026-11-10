// strict: implicit any, null checks, satisfies, async results.
export function implicit(value) {
	return value;
}
export function nullable(text: string | null): number {
	return text.length;
}
export const config = { port: "80" } satisfies { port: number };
export async function load(): Promise<number> {
	return "late";
}
export function narrow(value: string | number): string {
	if (typeof value === "string") return value;
	return value;
}
type Route = `/${string}`;
export const route: Route = "home";
