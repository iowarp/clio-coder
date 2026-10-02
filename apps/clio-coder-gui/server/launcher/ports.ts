/**
 * The background app keeps one address forever so a browser's installed app and remembered token keep
 * working across restarts. 4343 is that address. When another program owns it the app listens on 7373
 * instead, and every launcher looks at the same two ports in the same order.
 */
export const DEFAULT_GUI_PORT = 4343;
export const FALLBACK_GUI_PORT = 7373;

/** Ports a background app configured for `port` may be listening on, preferred first. */
export function listenPorts(port: number): number[] {
	return port === FALLBACK_GUI_PORT ? [port] : [port, FALLBACK_GUI_PORT];
}
