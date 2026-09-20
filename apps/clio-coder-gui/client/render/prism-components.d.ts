/** Prism grammar components have no bundled typings; each registers itself on the global Prism when imported. */
declare module "prismjs/components/*" {
	const component: unknown;
	export default component;
}
