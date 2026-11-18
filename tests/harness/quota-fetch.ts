export interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

/** A fetch that records each request's URL and headers and answers with `respond`. */
export function stubFetch(
	respond: () => Response | Promise<Response> | never,
	calls: FetchCall[] = [],
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: String(input), headers: Object.fromEntries(headers.entries()) });
		return await respond();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
