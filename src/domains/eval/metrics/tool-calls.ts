export function zeroToolCallMetrics(): Record<string, number> {
	return {
		"tools.totalCalls": 0,
		"tools.failed": 0,
		"tools.blocked": 0,
	};
}
