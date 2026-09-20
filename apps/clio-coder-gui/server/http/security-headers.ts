/**
 * The Content-Security-Policy every response carries.
 *
 * Inline styles are allowed for Mermaid diagrams only: strict Mermaid output is
 * DOMPurify-sanitized SVG whose theme lives in an embedded stylesheet, and no
 * code path renders model-authored HTML. Scripts stay same-origin only, and
 * img-src, font-src and connect-src still block CSS-driven fetches. `connect-src`
 * needs no `ws:` grant because the live surface is SSE on this same origin.
 */
export const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"manifest-src 'self'",
	"worker-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

/**
 * `frame-ancestors` alongside `X-Frame-Options` is deliberate: the former is
 * ignored in the `<meta>` fallback the client ships, so the header form is what
 * actually pins framing for a build served by anything but this listener.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": CSP,
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};
