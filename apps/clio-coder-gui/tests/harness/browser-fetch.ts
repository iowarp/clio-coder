/** A browser fetch whose server issues credentials and stream tickets; every other call goes to `handler`. */
export function credentialFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
		new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
): typeof fetch {
	let issued = 0;
	return (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		if (url === "/api/auth/clients" || url === "/api/auth/rotate") {
			issued += 1;
			return Response.json({
				clientId: "browser-client-1",
				label: "Browser window",
				credential: `credential-${String(issued).padStart(32, "0")}-xxxxxx`,
				expiresAt: new Date(Date.now() + 900_000).toISOString(),
				expiresIn: 900,
				rotateIn: 450,
			});
		}
		if (url === "/api/events/ticket") return Response.json({ ticket: "t".repeat(43), expiresIn: 30 });
		return handler(url, init);
	}) as typeof fetch;
}
