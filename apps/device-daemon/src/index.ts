import { describeVendors, loadDeviceConfig, readDeviceToken } from "./config";
import { createDispatcher } from "./dispatch";
import { createConsoleLogger } from "./logger";
import { runPollLoop } from "./poll";

/**
 * Device daemon entry point.
 *
 * Boot order: load and validate the device-local config, read the bearer token
 * from the daemon's own environment, build the 31-entry connector table, then
 * poll. The startup summary lists configured vendor names and the poll
 * interval only — never a token, env value, provider URL with credentials, tool
 * param or provider response.
 *
 * SIGINT/SIGTERM abort the loop; an in-flight claim or provider call finishes
 * within its own timeout, then the process exits 0.
 */

export type DaemonMainOptions = {
	env?: Record<string, string | undefined>;
	configPath?: string;
};

export async function runDaemon(
	options: DaemonMainOptions = {},
): Promise<number> {
	const env = options.env ?? process.env;
	const logger = createConsoleLogger();
	const config = await loadDeviceConfig({
		env,
		...(options.configPath === undefined
			? {}
			: { configPath: options.configPath }),
	});
	const deviceToken = readDeviceToken(config, env);
	const dispatch = createDispatcher({ config, env });

	logger.info("boot", {
		verdict: "starting",
		vendors: describeVendors(config).join(",") || "none",
		pollIntervalMs: config.pollIntervalMs,
	});

	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const result = await runPollLoop({
			serverUrl: config.serverUrl,
			deviceToken,
			dispatch,
			logger,
			pollIntervalMs: config.pollIntervalMs,
			signal: controller.signal,
		});
		if (result.reason === "unauthorized") {
			logger.error("stopped", {
				reason: "unauthorized",
				detail: "device token was rejected; register the device again",
			});
			return 2;
		}
		if (result.reason === "fatal") {
			logger.error("stopped", {
				reason: "fatal",
				detail: result.detail ?? "device gateway returned an unexpected status",
			});
			return 1;
		}
		logger.info("stopped", { reason: "signal" });
		return 0;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

export async function main(
	env: Record<string, string | undefined>,
): Promise<void> {
	try {
		const code = await runDaemon({ env });
		process.exitCode = code;
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown failure";
		// Config errors are fixed strings that never carry a secret value.
		console.error(`[device-daemon] error startup failed: ${message}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main(process.env);
}
