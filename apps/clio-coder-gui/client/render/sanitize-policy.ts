/**
 * Mermaid's embedded stylesheet stays: it is scoped to the diagram id and the
 * page CSP keeps every url() it could name on this origin. Everything that
 * could navigate, embed, or run is removed.
 */
export const SANITIZE_CONFIG = {
	USE_PROFILES: { svg: true, svgFilters: true },
	FORBID_TAGS: ["foreignObject", "script", "a", "image", "iframe", "object", "embed", "animate", "set"],
	FORBID_ATTR: ["href", "xlink:href", "onload", "onclick", "onerror", "onmouseover"],
};
