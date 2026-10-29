import { PlatformError } from "@isolate/shared";
import type { AgentUsage, OpenAICompatibleModelConfig } from "./types";

/**
 * Baseten Model APIs are OpenAI-compatible; Mastra addresses them with the
 * object form `{ providerId, modelId, url, apiKey }`. The platform standardizes
 * on the Meta Muse Spark Open snapshot `meta-models/muse-spark-open-1026` and
 * never falls back to another model or provider. `BASETEN_MODEL_ID` may pin the
 * same family only.
 */
export const BASETEN_PROVIDER_ID = "baseten";
/** The only inference model this platform uses (Meta Muse Spark Open, 1026). */
export const BASETEN_DEFAULT_MODEL_ID = "meta-models/muse-spark-open-1026";
export const BASETEN_DEFAULT_BASE_URL = "https://inference.baseten.co/v1";

/** Bounds keep config errors and provider payloads free of unbounded input. */
const MAX_URL_LENGTH = 2048;
const MAX_MODEL_ID_LENGTH = 200;

/**
 * Builds the Baseten model config from injected env. Fails closed: a missing or
 * blank key throws `MISSING_CONFIG` and the error message never contains the
 * key (or any env value).
 */
export function basetenModelConfig(
	env: Record<string, string | undefined>,
): OpenAICompatibleModelConfig {
	const apiKey = env.BASETEN_API_KEY;
	if (apiKey === undefined || apiKey.trim() === "") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"BASETEN_API_KEY is required when INFERENCE_PROVIDER=baseten",
		);
	}

	const modelId = env.BASETEN_MODEL_ID?.trim() || BASETEN_DEFAULT_MODEL_ID;
	if (modelId.length > MAX_MODEL_ID_LENGTH) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`BASETEN_MODEL_ID must be at most ${MAX_MODEL_ID_LENGTH} characters`,
		);
	}

	const url = env.BASETEN_BASE_URL?.trim() || BASETEN_DEFAULT_BASE_URL;
	if (url.length > MAX_URL_LENGTH) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`BASETEN_BASE_URL must be at most ${MAX_URL_LENGTH} characters`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// No URL value in the message: it could carry credentials.
		throw new PlatformError(
			"VALIDATION_FAILED",
			"BASETEN_BASE_URL must be a valid https URL",
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"BASETEN_BASE_URL must be an https URL without embedded credentials",
		);
	}

	return {
		providerId: BASETEN_PROVIDER_ID,
		modelId,
		url,
		apiKey,
	};
}

/**
 * Trusted price table, injected by the composition root. Keys are model ids;
 * prices are USD per one million tokens. The platform never ships a default
 * price: absence of an entry yields `null` cost rather than a guess.
 */
export type UsagePriceTable = Record<
	string,
	{ promptUsdPerMillion: number; completionUsdPerMillion: number }
>;

type CostInput = Pick<
	AgentUsage,
	"modelId" | "promptTokens" | "completionTokens"
>;

function isTrustedPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTrustedTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Estimates spend for one model call from a configured price table.
 *
 * Returns `null` when the table is absent, the model has no configured price,
 * the prices are not finite non-negative numbers, or the token counts are not
 * trustworthy. Callers persist the result; they never substitute a guess.
 */
export function estimateUsageCostUsd(
	usage: CostInput,
	table: UsagePriceTable | undefined,
): number | null {
	if (table === undefined) return null;
	const entry = table[usage.modelId];
	if (entry === undefined) return null;
	if (
		!isTrustedPrice(entry.promptUsdPerMillion) ||
		!isTrustedPrice(entry.completionUsdPerMillion) ||
		!isTrustedTokenCount(usage.promptTokens) ||
		!isTrustedTokenCount(usage.completionTokens)
	) {
		return null;
	}
	const cost =
		(usage.promptTokens * entry.promptUsdPerMillion +
			usage.completionTokens * entry.completionUsdPerMillion) /
		1_000_000;
	return Number.isFinite(cost) ? cost : null;
}
