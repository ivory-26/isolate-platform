import { PlatformError } from "@isolate/shared";
import { BASETEN_DEFAULT_MODEL_ID, BASETEN_PROVIDER_ID } from "./baseten";
import { META_MODEL_ID, META_PROVIDER_ID } from "./meta";

/**
 * Static provider/model registry (T3 Code harness study P0-1).
 *
 * This is a declaration, not a router: it names the only two hosted inference
 * models the platform may use, records what is honestly supported today, and
 * lets composition and call sites look a descriptor up instead of checking a
 * provider name in several files. It reads no credential and performs no
 * network call.
 */

/**
 * Typed capability groups limited to what the harness can honestly claim
 * today. There are deliberately no subagent/planning/checkpoint flags.
 */
export const PROVIDER_CAPABILITY_KEYS = [
	"streaming",
	"toolCalls",
	"approvals",
	"session",
	"context",
] as const;

export type ProviderCapabilities = {
	/** Token deltas can be streamed from the provider. */
	streaming: boolean;
	/** The model may request tool calls. */
	toolCalls: boolean;
	/** Tool calls pass through the persisted approval policy gate. */
	approvals: boolean;
	/** A provider session can be resumed across turns/jobs. */
	session: boolean;
	/** Context-window metadata is configured and enforceable. */
	context: boolean;
};

/**
 * One configuration/account lifecycle for a provider. We run exactly one
 * deployment instance per provider, so `instanceId` is the provider id.
 */
export type ModelDescriptor = {
	instanceId: string;
	providerId: string;
	modelId: string;
	/**
	 * Verified context window, or `null` when no window has been verified. A
	 * null window disables prompt preflight; it is never guessed.
	 */
	contextWindowTokens: number | null;
	maxOutputTokens: number;
	supportsToolCalls: boolean;
	supportsStreaming: boolean;
	supportsReasoning: boolean;
	/** Price-table key; equal to `modelId` for the current models. */
	priceKey: string;
	/** Honest capability record for this descriptor. */
	capabilities: ProviderCapabilities;
};

/**
 * Capabilities for a runtime whose provider was not declared in the catalog.
 * Conservative by design: a missing descriptor must not advertise a feature.
 */
export const UNKNOWN_PROVIDER_CAPABILITIES: ProviderCapabilities =
	Object.freeze({
		streaming: false,
		toolCalls: false,
		approvals: false,
		session: false,
		context: false,
	});

/**
 * The two current models. `contextWindowTokens` stays `null` until a window is
 * verified and configured through `WORKER_MODEL_CONTEXT_WINDOW`; the study
 * explicitly forbids inventing a tokenizer or a window.
 */
const SHARED_CAPABILITIES: ProviderCapabilities = Object.freeze({
	streaming: false,
	toolCalls: true,
	approvals: true,
	session: false,
	context: false,
});

export const MODEL_CATALOG: readonly ModelDescriptor[] = Object.freeze([
	Object.freeze({
		instanceId: META_PROVIDER_ID,
		providerId: META_PROVIDER_ID,
		modelId: META_MODEL_ID,
		contextWindowTokens: null,
		maxOutputTokens: 8192,
		supportsToolCalls: true,
		supportsStreaming: false,
		supportsReasoning: true,
		priceKey: META_MODEL_ID,
		capabilities: SHARED_CAPABILITIES,
	} satisfies ModelDescriptor),
	Object.freeze({
		instanceId: BASETEN_PROVIDER_ID,
		providerId: BASETEN_PROVIDER_ID,
		modelId: BASETEN_DEFAULT_MODEL_ID,
		contextWindowTokens: null,
		maxOutputTokens: 8192,
		supportsToolCalls: true,
		supportsStreaming: false,
		supportsReasoning: true,
		priceKey: BASETEN_DEFAULT_MODEL_ID,
		capabilities: SHARED_CAPABILITIES,
	} satisfies ModelDescriptor),
]);

const BY_PROVIDER: ReadonlyMap<string, ModelDescriptor> = new Map(
	MODEL_CATALOG.map((descriptor) => [descriptor.providerId, descriptor]),
);

/**
 * Resolves the descriptor for a provider id. Unknown providers fail closed;
 * the message is static so no environment value is echoed.
 */
export function resolveModelDescriptor(providerId: string): ModelDescriptor {
	const descriptor = BY_PROVIDER.get(providerId);
	if (descriptor === undefined) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"unknown inference provider; expected 'meta' or 'baseten'",
		);
	}
	return descriptor;
}
