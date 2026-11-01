const dateTime = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
	timeZoneName: "short",
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "2-digit",
	timeZone: "UTC",
});

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function asDate(value: string | Date): Date | null {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(value: string | Date | null | undefined) {
	if (!value) return "—";
	const parsed = asDate(value);
	return parsed ? dateTime.format(parsed) : "—";
}

export function formatDate(value: string | Date | null | undefined) {
	if (!value) return "—";
	const parsed = asDate(value);
	return parsed ? dateOnly.format(parsed) : "—";
}

export function formatDurationMs(value: number | null | undefined) {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
	const seconds = Math.round(value / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds === 0
			? `${minutes}m`
			: `${minutes}m ${remainingSeconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0
		? `${hours}h`
		: `${hours}h ${remainingMinutes}m`;
}

export function formatTokens(value: number | null | undefined) {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return value < 1000 ? integer.format(value) : compact.format(value);
}

export function formatNumber(value: number | null | undefined) {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return integer.format(value);
}

/**
 * Costs arrive as exact `numeric(12,6)` strings. A null cost means the provider
 * had no trusted price, never zero.
 */
export function formatCost(value: string | number | null | undefined) {
	if (value === null || value === undefined) return "—";
	const amount = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(amount)) return "—";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: amount < 0.01 ? 4 : 2,
		maximumFractionDigits: amount < 0.01 ? 4 : 2,
	}).format(amount);
}

export function shortId(value: string, length = 8) {
	return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function relativeTime(value: string | Date, now = Date.now()) {
	const parsed = asDate(value);
	if (!parsed) return "—";
	const deltaMs = parsed.getTime() - now;
	const deltaSeconds = Math.round(deltaMs / 1000);
	const absoluteSeconds = Math.abs(deltaSeconds);
	if (absoluteSeconds < 45) return "just now";
	if (absoluteSeconds < 3600) {
		return relative.format(Math.round(deltaSeconds / 60), "minute");
	}
	if (absoluteSeconds < 86_400) {
		return relative.format(Math.round(deltaSeconds / 3600), "hour");
	}
	if (absoluteSeconds < 2_592_000) {
		return relative.format(Math.round(deltaSeconds / 86_400), "day");
	}
	return formatDate(parsed);
}

export function statusLabel(value: string) {
	const spaced = value.replaceAll("_", " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
