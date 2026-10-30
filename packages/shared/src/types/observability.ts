import { z } from "zod";

/**
 * Blob storage contract (wave 11).
 *
 * Large patches and log bundles outgrow the 256 KiB inline artifact column.
 * A `BlobStore` keeps the bytes and `artifacts.storage_ref` points at them;
 * small payloads may keep the inline column. Implementations must be
 * tenant-scoped on read and must never return another organization's bytes.
 */

export type BlobKind = "diff" | "log_bundle" | "report" | "screenshot";

export type BlobStorePutInput = {
	readonly organizationId: string;
	readonly taskId: string | null;
	readonly kind: BlobKind;
	readonly contentType: string;
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

export type BlobRef = {
	/** Stable reference persisted on the artifact (`blob:<sha256>` or similar). */
	readonly storageRef: string;
	readonly byteSize: number;
	readonly sha256: string;
};

export type BlobStoreGetInput = {
	readonly organizationId: string;
	readonly storageRef: string;
};

export type BlobStoreValue = {
	readonly bytes: Uint8Array;
	readonly contentType: string;
	readonly sha256: string;
};

export interface BlobStore {
	put(input: BlobStorePutInput): Promise<BlobRef>;
	/** `null` when absent or owned by another organization (indistinguishable). */
	get(input: BlobStoreGetInput): Promise<BlobStoreValue | null>;
}

/**
 * Trusted cost table. Prices are configuration, never guesses: an absent model
 * or table yields `null`, which the platform records as "unknown", not zero.
 */
export const costPriceTableSchema = z
	.object({
		models: z
			.array(
				z
					.object({
						modelId: z.string().min(1).max(200),
						/** USD per one million prompt tokens. */
						promptTokenUsdPerMillion: z.number().min(0).max(10_000),
						/** USD per one million completion tokens. */
						completionTokenUsdPerMillion: z.number().min(0).max(10_000),
					})
					.strict(),
			)
			.max(100),
		sandbox: z
			.object({
				cpuSecondUsd: z.number().min(0).max(100),
				gibSecondUsd: z.number().min(0).max(100),
			})
			.strict(),
	})
	.strict();

export type CostPriceTable = z.infer<typeof costPriceTableSchema>;

/** Exact micro-dollar-safe cost for one model call, rounded to 6 decimals. */
export function modelCallCostUsd(
	input: {
		readonly modelId: string;
		readonly promptTokens: number;
		readonly completionTokens: number;
	},
	table: CostPriceTable | null,
): number | null {
	if (table === null) return null;
	const entry = table.models.find((model) => model.modelId === input.modelId);
	if (entry === undefined) return null;
	const prompt = Math.max(0, input.promptTokens);
	const completion = Math.max(0, input.completionTokens);
	const cost =
		(prompt * entry.promptTokenUsdPerMillion +
			completion * entry.completionTokenUsdPerMillion) /
		1_000_000;
	return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Sandbox cost from measured seconds and the provisioned CPU/memory. */
export function sandboxCostUsd(
	input: {
		readonly cpuCount: number;
		readonly memoryMb: number;
		readonly seconds: number;
	},
	table: CostPriceTable | null,
): number | null {
	if (table === null) return null;
	const cpu = Math.max(0, input.cpuCount);
	const gib = Math.max(0, input.memoryMb) / 1024;
	const seconds = Math.max(0, input.seconds);
	const cost =
		seconds *
		(cpu * table.sandbox.cpuSecondUsd + gib * table.sandbox.gibSecondUsd);
	return Math.round(cost * 1_000_000) / 1_000_000;
}

export const VALIDATION_OUTCOMES = ["passed", "failed", "skipped"] as const;

/** Bounded per-task rollup for operators; assembled from durable rows only. */
export const runSummarySchema = z
	.object({
		taskId: z.string().min(1).max(64),
		status: z.string().min(1).max(64),
		promptTokens: z.number().int().min(0),
		completionTokens: z.number().int().min(0),
		sandboxSeconds: z.number().int().min(0),
		/** `null` when no trusted price covers the run. */
		costUsd: z.number().min(0).nullable(),
		attempts: z.number().int().min(0).max(1000),
		artifacts: z.number().int().min(0).max(10_000),
		validation: z.enum(VALIDATION_OUTCOMES).nullable(),
		pullRequest: z
			.object({ number: z.number().int().positive(), url: z.string().max(512) })
			.strict()
			.nullable(),
	})
	.strict();

export type RunSummary = z.infer<typeof runSummarySchema>;
