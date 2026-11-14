// Where focus goes after an action that removes the control that had it. Both helpers only ever move
// focus that has nowhere to be (`<body>`, or the page region the route change parks it on); focus the
// operator has already put somewhere else is left alone.

const COMPOSER = ".composer__field:not(:disabled)";
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function parked(element: Element | null): boolean {
	return element === null || element === document.body || element.id === "main";
}

/**
 * Put focus in the message box once it is on screen, for "New task" from a button or a chord. A route
 * change focuses `#main` a frame after it lands and a fresh page mounts its composer later still, so
 * this follows along for a few seconds and stops the moment focus goes anywhere else.
 */
export function focusComposerSoon(timeoutMs = 3000): void {
	const started = performance.now();
	const opener = document.activeElement;
	const step = () => {
		const active = document.activeElement;
		const field = document.querySelector<HTMLElement>(COMPOSER);
		// A page that focuses its own message box on mount is following along, not moving on.
		const free = parked(active) || active === opener || active?.matches(COMPOSER) === true;
		if (!free) return;
		if (field && active !== field) field.focus();
		if (performance.now() - started < timeoutMs) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/**
 * After `element` (an in-place editor) unmounts, focus the first control in its nearest surviving
 * ancestor: committing a rename returns to the title it renamed, not to `<body>`.
 */
export function returnFocusNear(element: Element | null): void {
	const ancestors: Element[] = [];
	for (let node = element?.parentElement ?? null; node && node !== document.body; node = node.parentElement)
		ancestors.push(node);
	const settle = (tries: number) =>
		requestAnimationFrame(() => {
			if (!parked(document.activeElement) && document.activeElement?.isConnected) return;
			const host = ancestors.find((node) => node.isConnected);
			const target = host?.matches(FOCUSABLE) ? host : host?.querySelector<HTMLElement>(FOCUSABLE);
			if (target instanceof HTMLElement) target.focus();
			else if (tries > 0) settle(tries - 1);
		});
	settle(2);
}
