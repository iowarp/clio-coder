// A minimal automatic JSX runtime, so the corpus needs no React types.
export interface Node {
	readonly tag: unknown;
}
export function jsx(tag: unknown, _props: unknown): Node {
	return { tag };
}
export const jsxs = jsx;
export const Fragment = Symbol("Fragment");
export namespace JSX {
	export type Element = Node;
	export interface ElementChildrenAttribute {
		children: unknown;
	}
	export interface IntrinsicElements {
		div: { id?: string; children?: unknown };
		button: { disabled?: boolean; onClick?: (event: MouseEvent) => void; children?: unknown };
	}
}
