import { PlatformError } from "@isolate/shared";
import type { OpenAICompatibleModelConfig } from "./types";

/**
 * Meta Model API (local/dev + pre-production agent tests).
 *
 * OpenAI-compatible at `https://api.meta.ai/v1`. This platform uses exactly one
 * Meta model — Muse Spark 1.3 Contributor — for agentic tests before production;
 * production inference stays on Baseten (Muse Spark Open 1026). The model id is
 * not configurable to another model: a different value fails closed.
 */
export const META_PROVIDER_ID = "meta";
export const META_MODEL_ID = "muse-spark-1.3-contributor";
export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1";

const MAX_URL_LENGTH = 2048;

export function metaModelConfig(
	env: Record<string, string | undefined>,
): OpenAICompatibleModelConfig {
	const apiKey = env.META_API_KEY;
	if (apiKey === undefined || apiKey.trim() === "") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"META_API_KEY is required when INFERENCE_PROVIDER=meta",
		);
	}

	const requestedModel = env.META_MODEL_ID?.trim();
	if (requestedModel !== undefined && requestedModel !== "") {
		if (requestedModel !== META_MODEL_ID) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				`META_MODEL_ID must be ${META_MODEL_ID}`,
			);
		}
	}

	const url = env.META_BASE_URL?.trim() || META_DEFAULT_BASE_URL;
	if (url.length > MAX_URL_LENGTH) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`META_BASE_URL must be at most ${MAX_URL_LENGTH} characters`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// No URL value in the message: it could carry credentials.
		throw new PlatformError(
			"VALIDATION_FAILED",
			"META_BASE_URL must be a valid https URL",
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"META_BASE_URL must be an https URL without embedded credentials",
		);
	}

	return {
		providerId: META_PROVIDER_ID,
		modelId: META_MODEL_ID,
		url,
		apiKey,
	};
}
