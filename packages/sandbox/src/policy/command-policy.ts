import { deny, SandboxError } from "../errors";
import { validateSandboxPath } from "./paths";

export type EgressPolicy =
	| { readonly mode: "deny" }
	| { readonly mode: "allowlist"; readonly hosts: readonly string[] };

export type ArgumentRule =
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "oneOf"; readonly values: readonly string[] }
	| {
			readonly kind: "pattern";
			readonly pattern: RegExp;
			readonly maxLength: number;
	  };

export interface CommandRule {
	/** Fixed command from the provider's trusted image, never cwd/repo-controlled PATH. */
	readonly executable: string;
	readonly args: readonly ArgumentRule[];
}

/** Trusted application configuration, never repository/model-supplied permissions. */
export interface CommandPolicy {
	readonly workspaceRoot: string;
	readonly allowlist: readonly CommandRule[];
	readonly maxTimeoutMs: number;
	readonly maxOutputBytes: number;
	readonly egress: EgressPolicy;
}

export interface CommandRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs: number;
	/** Combined stdout + stderr UTF-8 byte budget, not per-stream/character count. */
	readonly maxOutputBytes: number;
	readonly egress?: EgressPolicy;
}

const authorization: unique symbol = Symbol("authorized-command");
export type AuthorizedCommand = Readonly<Required<CommandRequest>> & {
	readonly [authorization]: true;
};

/**
 * Hard ceiling for a policy's own timeout. Per-command policies still cap the
 * request at `maxTimeoutMs`; only the wave-8 validation gate raises that policy
 * value because a repository test suite may legitimately run for 15 minutes
 * (the DB check allows 1000–900000 ms).
 */
export const MAX_TIMEOUT_MS = 900_000;
export const MAX_OUTPUT_BYTES = 1_048_576;

/** One bounded, identifier-shaped package script name. */
export const VALIDATION_SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/**
 * Wave-8 validation allowlist: repository test entry points only, as exact
 * argv shapes. Read-only Git is deliberately absent — validation is not a
 * general command channel.
 */
export const VALIDATION_COMMAND_ALLOWLIST: readonly CommandRule[] = [
	{ executable: "bun", args: [{ kind: "literal", value: "test" }] },
	{
		executable: "bun",
		args: [
			{ kind: "literal", value: "run" },
			{ kind: "pattern", pattern: VALIDATION_SCRIPT_NAME, maxLength: 64 },
		],
	},
	{ executable: "npm", args: [{ kind: "literal", value: "test" }] },
	{
		executable: "npm",
		args: [
			{ kind: "literal", value: "run" },
			{ kind: "pattern", pattern: VALIDATION_SCRIPT_NAME, maxLength: 64 },
		],
	},
	{ executable: "pytest", args: [] },
	{ executable: "cargo", args: [{ kind: "literal", value: "test" }] },
	{ executable: "go", args: [{ kind: "literal", value: "test" }] },
];

function boundedInteger(
	value: number,
	maximum: number,
	hardLimit: number,
): void {
	if (
		!Number.isSafeInteger(maximum) ||
		maximum < 1 ||
		maximum > hardLimit ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > maximum
	) {
		deny("Requested resource limit is not allowed");
	}
}

export function validateTimeout(value: number, maximum: number): number {
	boundedInteger(value, maximum, MAX_TIMEOUT_MS);
	return value;
}

export function validateOutputLimit(value: number, maximum: number): number {
	boundedInteger(value, maximum, MAX_OUTPUT_BYTES);
	return value;
}

function validArg(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length <= 4096 &&
		!Array.from(value).some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

/** Exact positional argv; variable patterns never authorize flags or shell syntax. */
export function validateArgs(
	args: readonly string[],
	rules: readonly ArgumentRule[],
): void {
	if (
		!Array.isArray(args) ||
		args.length > 128 ||
		args.length !== rules.length
	) {
		deny("Command argument shape is not allowlisted");
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const rule = rules[index];
		if (!validArg(arg)) deny("Invalid command argument");
		let allowed = false;
		switch (rule.kind) {
			case "literal":
				allowed = arg === rule.value;
				break;
			case "oneOf":
				allowed = rule.values.includes(arg);
				break;
			case "pattern": {
				if (
					!Number.isSafeInteger(rule.maxLength) ||
					rule.maxLength < 1 ||
					rule.maxLength > 4096
				) {
					deny("Invalid argument pattern limit");
				}
				if (arg.length > rule.maxLength)
					deny("Argument exceeds its allowlisted length");
				const regex = new RegExp(
					rule.pattern.source,
					rule.pattern.flags.replace(/[gy]/g, ""),
				);
				const match = regex.exec(arg);
				allowed =
					arg.length <= rule.maxLength &&
					!arg.startsWith("-") &&
					!/[;&|`<>]/.test(arg) &&
					!arg.includes(String.fromCharCode(92)) &&
					!arg.includes(String.fromCharCode(36)) &&
					match !== null &&
					match[0] === arg &&
					match.index === 0;
				break;
			}
		}
		if (!allowed) deny("Command argument is not allowlisted");
	}
}

function hosts(policy: EgressPolicy): readonly string[] {
	if (policy.mode === "deny") return [];
	if (
		policy.mode !== "allowlist" ||
		!Array.isArray(policy.hosts) ||
		policy.hosts.length === 0 ||
		policy.hosts.length > 32
	) {
		deny("Invalid egress policy");
	}
	for (const host of policy.hosts) {
		if (
			typeof host !== "string" ||
			host.length > 253 ||
			!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
			/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(
				host,
			)
		) {
			deny("Egress requires explicit public DNS hostnames");
		}
	}
	return policy.hosts;
}

/** HTTPS:443 intent only. Providers enforce DNS/IP/redirect confinement. */
export function validateEgress(
	requested: EgressPolicy,
	permitted: EgressPolicy,
): EgressPolicy {
	const allowed = hosts(permitted);
	const requestedHosts = hosts(requested);
	if (requestedHosts.some((host) => !allowed.includes(host)))
		deny("Egress destination is not allowlisted");
	return requested.mode === "deny"
		? Object.freeze({ mode: "deny" })
		: Object.freeze({
				mode: "allowlist",
				hosts: Object.freeze([...new Set(requestedHosts)]),
			});
}

export function commandPolicy(
	policy: CommandPolicy,
	request: CommandRequest,
): AuthorizedCommand {
	validateSandboxPath(policy.workspaceRoot, request.cwd);
	validateTimeout(request.timeoutMs, policy.maxTimeoutMs);
	validateOutputLimit(request.maxOutputBytes, policy.maxOutputBytes);
	if (
		typeof request.executable !== "string" ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(request.executable)
	) {
		deny("Executable must be an allowlisted image command");
	}
	const candidates = policy.allowlist.filter(
		(rule) => rule.executable === request.executable,
	);
	let matched = false;
	for (const rule of candidates) {
		try {
			validateArgs(request.args, rule.args);
			matched = true;
			break;
		} catch (error) {
			if (!(error instanceof SandboxError) || error.code !== "POLICY_DENIED")
				throw error;
		}
	}
	if (!matched) deny("Command is not explicitly allowlisted");
	return Object.freeze({
		executable: request.executable,
		args: Object.freeze([...request.args]),
		cwd: request.cwd,
		timeoutMs: request.timeoutMs,
		maxOutputBytes: request.maxOutputBytes,
		egress: validateEgress(request.egress ?? { mode: "deny" }, policy.egress),
		[authorization]: true as const,
	});
}
