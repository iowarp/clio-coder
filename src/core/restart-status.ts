let handingOver = false;

export function isRestartHandoff(): boolean {
	return handingOver;
}

export function markRestartHandoff(): void {
	handingOver = true;
}
