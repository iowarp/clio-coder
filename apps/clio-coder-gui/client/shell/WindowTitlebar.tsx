/** The installed PWA owns the title area; Windows keeps its real caption controls and resize edges. */
export function WindowTitlebar() {
	return (
		<div className="window-titlebar" aria-hidden="true">
			<span>Clio Coder</span>
		</div>
	);
}
