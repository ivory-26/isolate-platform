import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useSession } from "@/components/auth/SessionProvider";
import { CopyButton } from "@/components/common/copy-button";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import {
	ArrowRightIcon,
	CheckIcon,
	ConnectorsIcon,
	PlusIcon,
	RetryIcon,
	ServerIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { activeRole } from "@/features/auth/guard";
import { registerDevice, toDeviceApiError } from "@/features/devices/api";
import {
	type DeviceView,
	type IssuedDeviceToken,
	RELAY_OFFLINE_AFTER_MS,
	validateDeviceName,
} from "@/features/devices/contracts";
import { deviceKeys, deviceListOptions } from "@/features/devices/queries";
import {
	INTEGRATION_CATALOG,
	integrationCatalogEntry,
} from "@/features/integrations/catalog";
import {
	SEVERITIES,
	saveSubscriptionSchema,
} from "@/features/integrations/contracts";
import { saveSubscription } from "@/features/integrations/integrations.functions";
import { integrationKeys } from "@/features/integrations/queries";
import { repositoriesOptions } from "@/features/repositories/queries";
import type { SetupState } from "../contracts";
import { onboardingKeys, setupStateOptions } from "../queries";
import { buildRelayInstallCommand } from "../setup-steps";

const SELECT_CLASS =
	"h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * Four-step setup wizard: GitHub, relay, source, autonomy.
 *
 * Each step owns one primary action. Nothing asks for a provider secret, a
 * UUID, or a deployment environment edit: GitHub is an App install, the relay
 * token is shown once, the source credential is typed on the relay's loopback
 * page, and the trigger is a form.
 */
export function OnboardingWizard({ state }: { state: SetupState }) {
	const session = useSession();
	const role = activeRole(session);
	const canManage = role === "owner" || role === "admin";
	const queryClient = useQueryClient();
	const setupQuery = useQuery(setupStateOptions());
	const current = setupQuery.data?.ok ? setupQuery.data.value : state;

	return (
		<div className="space-y-10">
			<StepFrame
				index={1}
				id="setup-github"
				title="Connect GitHub"
				description="Install the Isolate GitHub App on selected repositories, then import the ones Isolate may work on."
				complete={current.githubConnected && current.hasRepository}
				currentStep={!current.githubConnected || !current.hasRepository}
			>
				<GitHubStep state={current} />
			</StepFrame>

			<StepFrame
				index={2}
				id="setup-relay"
				title="Install a relay"
				description="The relay holds provider secrets on your machine and reaches private networks. Register it once, run the command, and wait for the first heartbeat."
				complete={current.relayActive}
				currentStep={
					current.githubConnected &&
					current.hasRepository &&
					!current.relayActive
				}
			>
				<RelayStep state={current} canManage={canManage} />
			</StepFrame>

			<StepFrame
				index={3}
				id="setup-source"
				title="Connect a source"
				description="Pick a connector. The browser starts a pairing session; the credential is entered on the relay's loopback page and never reaches Isolate."
				complete={current.connectionActive}
				currentStep={current.relayActive && !current.connectionActive}
			>
				<SourceStep state={current} />
			</StepFrame>

			<StepFrame
				index={4}
				id="setup-autonomy"
				title="Set autonomy"
				description="Create the default production critical/high rule at A2 and map it to an imported repository."
				complete={current.triggerEnabled}
				currentStep={current.connectionActive && !current.triggerEnabled}
			>
				<AutonomyStep
					state={current}
					canManage={canManage}
					onSaved={async () => {
						await queryClient.invalidateQueries({
							queryKey: onboardingKeys.setup,
						});
						await queryClient.invalidateQueries({
							queryKey: integrationKeys.all,
						});
					}}
				/>
			</StepFrame>

			{current.complete ? (
				<div className="flex flex-col gap-3 border-t border-line-subtle pt-6 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<p className="text-sm font-medium text-ink">Ready</p>
						<p className="text-xs text-ink-muted">
							Home shows the first source and an empty inbox until an event
							arrives.
						</p>
					</div>
					<Button asChild>
						<Link to="/overview">
							Go to overview
							<ArrowRightIcon />
						</Link>
					</Button>
				</div>
			) : null}
		</div>
	);
}

function StepFrame({
	index,
	id,
	title,
	description,
	complete,
	currentStep,
	children,
}: {
	index: number;
	id: string;
	title: string;
	description: string;
	complete: boolean;
	currentStep: boolean;
	children: React.ReactNode;
}) {
	return (
		<ConsoleSection
			id={id}
			title={
				<span className="flex items-center gap-2">
					<span className="font-mono text-[11px] text-ink-muted tabular-nums">
						0{index}
					</span>
					{title}
					{complete ? (
						<span className="inline-flex items-center gap-1 rounded-full border border-success/30 px-2 py-0.5 text-[10px] text-success">
							<CheckIcon size={11} />
							Done
						</span>
					) : currentStep ? (
						<span className="rounded-full border border-brand/30 px-2 py-0.5 text-[10px] text-brand">
							Next
						</span>
					) : null}
				</span>
			}
			description={description}
			className={currentStep ? "border-l-2 border-brand pl-4" : undefined}
		>
			{children}
		</ConsoleSection>
	);
}

function GitHubStep({ state }: { state: SetupState }) {
	if (state.githubConnected && state.hasRepository) {
		return (
			<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-xs leading-5 text-ink-secondary">
					The GitHub App is installed and at least one repository is imported.
					Reads are scoped to this organization; no personal token is stored.
				</p>
				<Button asChild size="sm" variant="outline">
					<Link to="/repositories" search={{ q: "" }}>
						Manage repositories
						<ArrowRightIcon />
					</Link>
				</Button>
			</div>
		);
	}
	if (state.githubConnected) {
		return (
			<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-xs leading-5 text-ink-secondary">
					The App installation is connected. Select and import the repositories
					Isolate may work on.
				</p>
				<Button asChild size="sm">
					<Link to="/repositories" search={{ q: "" }}>
						Import repositories
						<ArrowRightIcon />
					</Link>
				</Button>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="space-y-1">
				<p className="text-xs leading-5 text-ink-secondary">
					No GitHub App installation is recorded for this organization yet.
				</p>
				<p className="text-xs text-ink-muted">
					GitHub returns you here after approval; repository selection follows.
				</p>
			</div>
			<div className="flex shrink-0 flex-wrap gap-2">
				<Button asChild>
					<a
						href="/api/github/install"
						target="_blank"
						rel="noopener noreferrer"
					>
						Install GitHub App
						<ArrowRightIcon />
					</a>
				</Button>
				<Button asChild variant="outline">
					<Link to="/repositories" search={{ q: "" }}>
						Open repositories
					</Link>
				</Button>
			</div>
		</div>
	);
}

function RelayStep({
	state,
	canManage,
}: {
	state: SetupState;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const [issued, setIssued] = useState<IssuedDeviceToken | null>(null);
	const [issuedName, setIssuedName] = useState("relay");
	const [error, setError] = useState<string | null>(null);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const devices = useQuery({
		...deviceListOptions(),
		refetchInterval: (query) =>
			query.state.data?.some((device) => device.status === "active")
				? 15_000
				: 4_000,
	});
	const register = useMutation({
		mutationFn: (displayName: string) => registerDevice(displayName),
		gcTime: 0,
		onSuccess: (result) => {
			setIssued(result);
			void queryClient.invalidateQueries({ queryKey: deviceKeys.all });
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (register.isPending) return;
		setError(null);
		const parsed = validateDeviceName(
			String(new FormData(event.currentTarget).get("displayName") ?? ""),
		);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		setIssuedName(parsed.value);
		register.mutate(parsed.value);
	}

	const relayDevices = devices.data ?? [];
	// A stored `active` status is not liveness: the row stays active after the
	// relay stops. Treat a heartbeat older than the same 5-minute window the
	// relays panel uses as offline so the wizard cannot claim a dead relay.
	const active = relayDevices.find(
		(device) =>
			device.status === "active" &&
			(!mounted ||
				(device.lastSeenAt !== null &&
					Date.now() - new Date(device.lastSeenAt).getTime() <=
						RELAY_OFFLINE_AFTER_MS)),
	);
	const command =
		issued === null
			? null
			: buildRelayInstallCommand({
					serverUrl:
						typeof window === "undefined" ? "" : window.location.origin,
					token: issued.token,
					name: issuedName,
				});

	return (
		<div className="space-y-4">
			{devices.error ? (
				<ErrorState
					title="Relays could not be loaded"
					message={toDeviceApiError(devices.error).message}
					onRetry={() => void devices.refetch()}
				/>
			) : null}
			{active ? (
				<div className="flex flex-col gap-2 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex items-center gap-3">
						<StatusMark status="active" />
						<span className="text-sm text-ink">{active.displayName}</span>
						<span className="text-xs text-ink-muted">
							{active.lastSeenAt ? (
								<RelativeTime value={active.lastSeenAt} />
							) : (
								"never seen"
							)}
						</span>
					</div>
					<Button asChild size="sm" variant="outline">
						<Link to="/integrations" search={{ tab: "relays" }}>
							Manage relays
							<ArrowRightIcon />
						</Link>
					</Button>
				</div>
			) : state.relayActive ? (
				<p className="text-xs text-ink-muted">
					A relay is active but this browser could not refresh its row yet.
				</p>
			) : (
				<ConsoleNote role="note" icon={ServerIcon}>
					No active relay. The relay is one small daemon per environment; every
					connector reuses it.
				</ConsoleNote>
			)}

			{!canManage ? (
				<ConsoleNote role="note">
					Only owners and admins can register a relay. Ask one to run this step.
				</ConsoleNote>
			) : issued === null ? (
				<form
					onSubmit={onSubmit}
					className="flex flex-col gap-3 sm:flex-row sm:items-end"
					noValidate
				>
					<div className="min-w-0 flex-1 space-y-1.5">
						<Label htmlFor="onboarding-relay-name">Relay name</Label>
						<Input
							id="onboarding-relay-name"
							name="displayName"
							required
							maxLength={100}
							autoComplete="off"
							placeholder="sre-laptop"
							aria-describedby="onboarding-relay-name-hint"
						/>
						<p
							id="onboarding-relay-name-hint"
							className="text-xs leading-5 text-ink-muted"
						>
							A label for this machine or environment. The token is shown once.
						</p>
					</div>
					<Button type="submit" disabled={register.isPending}>
						<PlusIcon />
						{register.isPending ? "Registering…" : "Register relay"}
					</Button>
				</form>
			) : (
				<div className="space-y-3 border-y border-line-subtle py-4">
					<ConsoleNote role="alert" tone="warning">
						This token is shown once. Run the command on the relay machine now;
						clearing it discards the only copy.
					</ConsoleNote>
					<div className="space-y-1.5">
						<p className="text-xs font-medium text-ink-muted">Relay token</p>
						<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
							<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
								{issued.token}
							</code>
							<CopyButton value={issued.token} label="Copy relay token" />
						</div>
					</div>
					{command === null ? (
						<p className="text-xs text-ink-muted">
							Open this page from your deployed Isolate URL to build a safe
							install command.
						</p>
					) : (
						<div className="space-y-1.5">
							<p className="text-xs font-medium text-ink-muted">
								Install command
							</p>
							<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
								<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
									{command}
								</code>
								<CopyButton value={command} label="Copy install command" />
							</div>
							<p className="text-xs leading-5 text-ink-muted">
								The relay reaches Isolate outbound over HTTPS; no inbound port
								is needed. It serves pairing on{" "}
								<code className="font-mono">127.0.0.1:47821</code>.
							</p>
						</div>
					)}
					<div className="flex flex-wrap items-center gap-3">
						<span className="text-xs text-ink-muted">
							{active
								? "Heartbeat received."
								: "Waiting for the first heartbeat…"}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => void devices.refetch()}
						>
							<RetryIcon />
							Check now
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setIssued(null)}
						>
							Clear token
						</Button>
					</div>
				</div>
			)}
			{error ? (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			) : null}
			{devices.isPending ? (
				<div className="space-y-2" aria-busy="true">
					<Skeleton className="h-5 w-full max-w-sm" />
				</div>
			) : relayDevices.length > 0 ? (
				<RelayStatusList devices={relayDevices} />
			) : null}
		</div>
	);
}

function RelayStatusList({ devices }: { devices: readonly DeviceView[] }) {
	return (
		<ul className="divide-y divide-line-subtle border-y border-line-subtle">
			{devices.slice(0, 5).map((device) => (
				<li
					key={device.id}
					className="flex items-center justify-between gap-3 py-2.5"
				>
					<span className="min-w-0 truncate text-xs text-ink">
						{device.displayName}
					</span>
					<StatusMark status={device.status} />
				</li>
			))}
		</ul>
	);
}

function SourceStep({ state }: { state: SetupState }) {
	const active = state.activeConnectorId
		? integrationCatalogEntry(state.activeConnectorId)
		: undefined;
	return (
		<div className="space-y-4">
			{active ? (
				<div className="flex flex-col gap-2 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex items-center gap-3">
						<StatusMark status="active" />
						<span className="text-sm text-ink">{active.label}</span>
						<span className="text-xs text-ink-muted">
							Credential held by the relay
						</span>
					</div>
					<Button asChild size="sm" variant="outline">
						<Link
							to="/integrations/$connectorId"
							params={{ connectorId: active.id }}
							search={{ tab: "catalog" }}
						>
							Open {active.label}
							<ArrowRightIcon />
						</Link>
					</Button>
				</div>
			) : (
				<ConsoleNote role="note" icon={ConnectorsIcon}>
					No source is connected. Connecting a connector needs an active relay
					and opens a one-time page on that relay.
				</ConsoleNote>
			)}
			<ul className="grid gap-x-6 divide-y divide-line-subtle border-y border-line-subtle sm:grid-cols-2 sm:divide-y-0">
				{INTEGRATION_CATALOG.filter((entry) => entry.id !== "github").map(
					(entry) => (
						<li key={entry.id} className="border-b border-line-subtle">
							<Link
								to="/integrations/$connectorId"
								params={{ connectorId: entry.id }}
								search={{ tab: "catalog" }}
								className="flex items-center justify-between gap-3 py-2.5 text-xs transition-colors hover:text-brand focus-visible:text-brand focus-visible:outline-none"
							>
								<span className="min-w-0">
									<span className="block text-sm text-ink">{entry.label}</span>
									<span className="block truncate text-[11px] text-ink-muted">
										{entry.category}
									</span>
								</span>
								<ArrowRightIcon size={14} className="shrink-0 text-ink-muted" />
							</Link>
						</li>
					),
				)}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button asChild size="sm">
					<Link to="/integrations" search={{ tab: "catalog" }}>
						<ConnectorsIcon />
						Open integration catalog
					</Link>
				</Button>
				<Button asChild size="sm" variant="ghost">
					<Link to="/integrations" search={{ tab: "relays" }}>
						Relay status
					</Link>
				</Button>
			</div>
		</div>
	);
}

function AutonomyStep({
	state,
	canManage,
	onSaved,
}: {
	state: SetupState;
	canManage: boolean;
	onSaved: () => Promise<void>;
}) {
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);
	const repositories = useQuery(repositoriesOptions({ q: "" }));
	const save = useMutation({
		mutationFn: saveSubscription,
		onSuccess: async (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			await onSaved();
			await navigate({ to: "/overview" });
		},
		onError: (cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "The trigger could not be saved.",
			),
	});

	const options = repositories.data?.ok
		? repositories.data.value.repositories
		: [];

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (save.isPending) return;
		setError(null);
		const form = new FormData(event.currentTarget);
		const parsed = saveSubscriptionSchema.safeParse({
			connectorId: state.activeConnectorId ?? "sentry",
			displayName: "Production critical/high",
			eventKinds: [],
			environmentAllowlist: ["production"],
			minSeverity: String(form.get("minSeverity") ?? "high"),
			repositoryId: String(form.get("repositoryId") ?? "") || null,
			baseBranch: String(form.get("baseBranch") ?? "").trim() || null,
			autonomyLevel: String(form.get("autonomyLevel") ?? "A2"),
			enabled: true,
		});
		if (!parsed.success) {
			setError(
				parsed.error.issues[0]?.message ??
					"Check the repository, severity and autonomy level.",
			);
			return;
		}
		save.mutate({ data: parsed.data });
	}

	if (!canManage) {
		return (
			<ConsoleNote role="note">
				Only owners and admins can create the default trigger.
			</ConsoleNote>
		);
	}
	if (state.activeConnectorId === null) {
		return (
			<ConsoleNote role="note" tone="warning">
				Connect a source first. The default trigger needs a connector and a
				repository.
			</ConsoleNote>
		);
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4" noValidate>
			{repositories.isPending ? (
				<Skeleton className="h-20 w-full" />
			) : repositories.error ? (
				<ErrorState
					title="Repositories could not be loaded"
					message="Retry the repository list before creating a trigger."
					onRetry={() => void repositories.refetch()}
				/>
			) : options.length === 0 ? (
				<EmptyRow
					title="No repositories imported"
					description="A2 prepares a fix in a clone, so the rule needs a repository and base branch."
					action={
						<Button asChild size="sm" variant="outline">
							<Link to="/repositories" search={{ q: "" }}>
								Import repositories
							</Link>
						</Button>
					}
				/>
			) : (
				<>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="onboarding-repository">Repository</Label>
							<select
								id="onboarding-repository"
								name="repositoryId"
								className={SELECT_CLASS}
								required
								defaultValue={options[0]?.id}
							>
								{options.map((repository) => (
									<option key={repository.id} value={repository.id}>
										{repository.externalFullName}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="onboarding-base-branch">Base branch</Label>
							<Input
								id="onboarding-base-branch"
								name="baseBranch"
								maxLength={255}
								autoComplete="off"
								placeholder={options[0]?.defaultBranch ?? "main"}
								aria-describedby="onboarding-base-branch-hint"
							/>
							<p
								id="onboarding-base-branch-hint"
								className="text-xs text-ink-muted"
							>
								Leave blank to use the repository default branch.
							</p>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="onboarding-severity">Minimum severity</Label>
							<select
								id="onboarding-severity"
								name="minSeverity"
								className={SELECT_CLASS}
								defaultValue="high"
							>
								{SEVERITIES.filter(
									(severity) => severity === "critical" || severity === "high",
								).map((severity) => (
									<option key={severity} value={severity}>
										{severity}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="onboarding-autonomy">Autonomy</Label>
							<select
								id="onboarding-autonomy"
								name="autonomyLevel"
								className={SELECT_CLASS}
								defaultValue="A2"
							>
								<option value="A2">A2 Prepare fix</option>
								<option value="A0">A0 Observe</option>
								<option value="A3">A3 Propose PR</option>
								<option value="A1" disabled>
									A1 Investigate (planned)
								</option>
							</select>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? "Creating…" : "Create default trigger"}
						</Button>
						<span className="text-xs text-ink-muted">
							Production · critical/high · A2 · connector defaults
						</span>
					</div>
				</>
			)}
			{error ? (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			) : null}
		</form>
	);
}
