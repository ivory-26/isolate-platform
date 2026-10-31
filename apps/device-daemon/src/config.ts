import { homedir } from "node:os";
import { join } from "node:path";
import { zodIssueSummary } from "@isolate/shared";
import { z } from "zod";

/**
 * Device-local configuration for the connector daemon.
 *
 * The daemon is the only place a provider key lives. This module validates the
 * non-secret selector file (`ISOLATE_DEVICE_CONFIG` or
 * `~/.isolate/connectors.json`) and resolves provider secrets from the
 * daemon's own environment, as named by `vendors.<vendor>.secretEnv`.
 *
 * Rules:
 * - Every object is strict: an unknown key is a configuration error, never a
 *   silent fallback to a broader credential.
 * - Provider URLs are https-only with no userinfo, query or fragment.
 * - Errors name a field path and a Zod code; they never echo a value, so a
 *   secret pasted into the wrong field cannot appear in a log.
 * - A keychain adapter is a later seam: `resolveSecret` is the single function
 *   that would read the OS keychain instead of `process.env`.
 */

export const DEVICE_CONFIG_PATH_ENV = "ISOLATE_DEVICE_CONFIG";
export const DEFAULT_DEVICE_CONFIG_PATH = join(
	homedir(),
	".isolate",
	"connectors.json",
);

/** `generateConnectorDeviceToken()` produces 32 bytes as 43 base64url chars. */
export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const DEVICE_VENDOR_NAMES = [
	"sentry",
	"grafana",
	"pagerduty",
	"kubernetes",
	"datadog",
	"newrelic",
	"honeycomb",
	"axiom",
	"signoz",
] as const;
export type DeviceVendorName = (typeof DEVICE_VENDOR_NAMES)[number];

export class DeviceConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeviceConfigError";
	}
}

function parseHttpsUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return null;
		if (url.username !== "" || url.password !== "") return null;
		if (url.search !== "" || url.hash !== "") return null;
		return url;
	} catch {
		return null;
	}
}

const httpsOriginSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine((value) => {
		const url = parseHttpsUrl(value);
		return url !== null && (url.pathname === "/" || url.pathname === "");
	}, "must be an https origin")
	.transform((value) => {
		const url = new URL(value);
		return url.origin;
	});

const httpsUrlSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine((value) => parseHttpsUrl(value) !== null, "must be an https url");

const envNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]{0,63}$/, "must be an env var name");

const timeoutSchema = z.number().int().min(1_000).max(30_000);

const sentryVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ token: envNameSchema }),
	baseUrl: httpsOriginSchema.optional(),
	timeoutMs: timeoutSchema.optional(),
});

const grafanaVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ token: envNameSchema }),
	baseUrl: httpsOriginSchema,
	orgId: z
		.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,10}$/)])
		.optional(),
	metricsDatasourceUid: z.string().min(1).max(64).optional(),
	logsDatasourceUid: z.string().min(1).max(64).optional(),
	timeoutMs: timeoutSchema.optional(),
});

const pagerdutyVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ token: envNameSchema }),
	/** Non-secret sender; `PAGERDUTY_FROM_EMAIL` is the env fallback. */
	fromEmail: z.email().max(254).optional(),
	baseUrl: httpsOriginSchema.optional(),
	timeoutMs: timeoutSchema.optional(),
});

const kubernetesVendorSchema = z.strictObject({
	secretEnv: z.strictObject({
		serviceAccountTokenFile: envNameSchema,
		caFile: envNameSchema.optional(),
	}),
	/** `KUBERNETES_API_URL` is the env fallback when omitted. */
	apiUrl: httpsUrlSchema.optional(),
	/** `KUBERNETES_NAMESPACE` is the env fallback when omitted. */
	namespace: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/)
		.optional(),
	clusterId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
		.optional(),
	timeoutMs: timeoutSchema.optional(),
});

const datadogVendorSchema = z.strictObject({
	secretEnv: z.strictObject({
		apiKey: envNameSchema,
		appKey: envNameSchema,
	}),
	baseUrl: httpsOriginSchema,
	logsEnabled: z.boolean().optional(),
	timeoutMs: timeoutSchema.optional(),
});

const newrelicVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ apiKey: envNameSchema }),
	accountId: z.union([
		z.string().regex(/^\d{1,20}$/),
		z.number().int().positive(),
	]),
	endpoint: httpsUrlSchema.optional(),
	timeoutMs: timeoutSchema.optional(),
});

const honeycombVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ apiKey: envNameSchema }),
	dataset: z.string().min(1).max(128),
	apiBaseUrl: httpsOriginSchema.optional(),
	timeoutMs: timeoutSchema.optional(),
});

const axiomVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ token: envNameSchema }),
	baseUrl: httpsOriginSchema,
	dataset: z.string().min(1).max(128),
	allowedDatasets: z.array(z.string().min(1).max(128)).max(10).optional(),
	timeoutMs: timeoutSchema.optional(),
});

const signozVendorSchema = z.strictObject({
	secretEnv: z.strictObject({ apiKey: envNameSchema }),
	baseUrl: httpsOriginSchema,
	timeoutMs: timeoutSchema.optional(),
});

export const deviceConfigSchema = z.strictObject({
	/** Platform origin; the daemon appends `/api/device/...` itself. */
	serverUrl: httpsOriginSchema,
	/** Name of the env var holding the 43-character device token. */
	deviceTokenEnv: envNameSchema,
	pollIntervalMs: z.number().int().min(250).max(60_000).default(2_000),
	vendors: z
		.strictObject({
			sentry: sentryVendorSchema.optional(),
			grafana: grafanaVendorSchema.optional(),
			pagerduty: pagerdutyVendorSchema.optional(),
			kubernetes: kubernetesVendorSchema.optional(),
			datadog: datadogVendorSchema.optional(),
			newrelic: newrelicVendorSchema.optional(),
			honeycomb: honeycombVendorSchema.optional(),
			axiom: axiomVendorSchema.optional(),
			signoz: signozVendorSchema.optional(),
		})
		.default({}),
});

export type DeviceConfig = z.output<typeof deviceConfigSchema>;
export type Env = Record<string, string | undefined>;
export type SentryVendorConfig = z.output<typeof sentryVendorSchema>;
export type GrafanaVendorConfig = z.output<typeof grafanaVendorSchema>;
export type PagerDutyVendorConfig = z.output<typeof pagerdutyVendorSchema>;
export type KubernetesVendorConfig = z.output<typeof kubernetesVendorSchema>;
export type DatadogVendorConfig = z.output<typeof datadogVendorSchema>;
export type NewRelicVendorConfig = z.output<typeof newrelicVendorSchema>;
export type HoneycombVendorConfig = z.output<typeof honeycombVendorSchema>;
export type AxiomVendorConfig = z.output<typeof axiomVendorSchema>;
export type SignozVendorConfig = z.output<typeof signozVendorSchema>;

export type LoadDeviceConfigOptions = {
	env?: Env;
	configPath?: string;
	readFile?: (path: string) => Promise<string>;
};

/** `ISOLATE_DEVICE_CONFIG` wins; otherwise `~/.isolate/connectors.json`. */
export function resolveConfigPath(env: Env = process.env): string {
	const override = env[DEVICE_CONFIG_PATH_ENV]?.trim();
	return override !== undefined && override.length > 0
		? override
		: DEFAULT_DEVICE_CONFIG_PATH;
}

/**
 * Reads and strictly validates the config file. Parse failures report field
 * paths and Zod codes only; no parsed value is included in the message.
 */
export async function loadDeviceConfig(
	options: LoadDeviceConfigOptions = {},
): Promise<DeviceConfig> {
	const env = options.env ?? process.env;
	const configPath = options.configPath ?? resolveConfigPath(env);
	const readFile =
		options.readFile ?? ((path: string) => Bun.file(path).text());
	let text: string;
	try {
		text = await readFile(configPath);
	} catch {
		throw new DeviceConfigError(
			`device config could not be read at ${configPath}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new DeviceConfigError("device config is not valid JSON");
	}
	const parsed = deviceConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new DeviceConfigError(
			`device config is invalid: ${zodIssueSummary(parsed.error)}`,
		);
	}
	return parsed.data;
}

/** Reads the bearer token from the device-local env var; never logs it. */
export function readDeviceToken(config: DeviceConfig, env: Env): string {
	const raw = env[config.deviceTokenEnv];
	const token = typeof raw === "string" ? raw.trim() : "";
	if (token.length === 0) {
		throw new DeviceConfigError("device token is not configured");
	}
	if (!DEVICE_TOKEN_PATTERN.test(token)) {
		throw new DeviceConfigError("device token is malformed");
	}
	return token;
}

/**
 * Resolves one provider secret by the env var name in `secretEnv`.
 *
 * This is the keychain seam: a later adapter would look up
 * `keychain:isolate/<vendor>/<field>` here instead of reading the environment.
 * A missing or empty value returns `null`; the caller fails closed and no
 * provider call is made.
 */
export function resolveSecret(
	secretEnv: Record<string, string> | undefined,
	field: string,
	env: Env,
): string | null {
	const name = secretEnv?.[field];
	if (name === undefined) return null;
	const value = env[name];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** Boot summary: configured vendor names only, sorted, never a secret. */
export function describeVendors(config: DeviceConfig): DeviceVendorName[] {
	const configured: DeviceVendorName[] = [];
	for (const name of DEVICE_VENDOR_NAMES) {
		if (config.vendors[name] !== undefined) configured.push(name);
	}
	return configured;
}
