// Runs before first paint. Both palettes use the same Clio brand tokens.
(() => {
	let theme = "dark";
	try {
		const requested = new URLSearchParams(location.search).get("theme");
		const saved = localStorage.getItem("clio-theme");
		theme = requested === "light" || requested === "dark" ? requested : saved === "light" ? "light" : "dark";
	} catch {
		// The default palette also works when browser storage is unavailable.
	}
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
})();
