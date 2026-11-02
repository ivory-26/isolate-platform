import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { RelativeTime } from "@/components/common/relative-time";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import {
	ArrowRightIcon,
	ExternalIcon,
	KeyIcon,
	LockIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	AUTH_KIND_LABELS,
	type DeviceView,
	parseScopeTokens,
} from "@/features/devices/contracts";
import type { IntegrationCatalogEntry } from "../catalog";
import {
	type CreatePairingInput,
	type IntegrationConnection,
	PAIRING_STATUS_LABELS,
	type PairingCreateView,
	type PairingSessionView,
} from "../contracts";
import {
	cancelPairing,
	createPairing,
	getPairingStatus,
	PAIRING_POLL_INTERVAL_MS,
	pairingErrorMessage,
} from "../pairing";
import { integrationKeys } from "../queries";

const SELECT_CLASS =
	"h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * Relay pairing wizard. The browser receives a one-time local URL served by the
 * relay; the provider credential is typed there. This component only ever sends
 * the relay id, connector id, display name, auth kind, keychain item name and
 * scopes.
 */
export function ConnectPairingPanel({
	entry,
	connection,
	relays,
	canManage,
	onConnected,
}: {
	entry: IntegrationCatalogEntry;
	connection: IntegrationConnection | null;
	relays: readonly DeviceView[];
	canManage: boolean;
	onConnected: () => void;
}) {
	const queryClient = useQueryClient();
	const activeRelays = relays.filter((relay) => relay.status === "active");
	const [pairing, setPairing] = useState<PairingCreateView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [started, setStarted] = useState(false);
	const [notified, setNotified] = useState(false);

	const statusQuery = useQuery({
		queryKey: ["integrations", "pairing", pairing?.pairingId ?? "none"],
		queryFn: () => getPairingStatus(pairing?.pairingId ?? ""),
		enabled: pairing !== null,
		retry: false,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "pending" || status === "claimed"
				? PAIRING_POLL_INTERVAL_MS
				: false;
		},
	});
	const status: PairingSessionView | undefined = statusQuery.data;

	const create = useMutation({
		mutationFn: (input: CreatePairingInput) => createPairing(input),
		onSuccess: (result) => {
			setPairing(result);
			setStarted(false);
			setNotified(false);
			setError(null);
		},
		onError: (cause) => setError(pairingErrorMessage(cause)),
	});
	const cancel = useMutation({
		mutationFn: (pairingId: string) => cancelPairing(pairingId),
		onSuccess: () => {
			setPairing(null);
			setError(null);
		},
		onError: (cause) => setError(pairingErrorMessage(cause)),
	});

	useEffect(() => {
		if (status?.status === "completed" && !notified) {
			setNotified(true);
			void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
			onConnected();
		}
	}, [status?.status, notified, onConnected, queryClient]);

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (create.isPending || activeRelays.length === 0) return;
		setError(null);
		const form = new FormData(event.currentTarget);
		const scopes = parseScopeTokens(String(form.get("scopes") ?? ""));
		if (!scopes.ok) {
			setError(scopes.error);
			return;
		}
		create.mutate({
			relayId: String(form.get("relayId") ?? ""),
			connectorId: entry.id,
			displayName: String(form.get("displayName") ?? ""),
			authKind: entry.defaultAuthKind,
			credentialRef: String(form.get("credentialRef") ?? ""),
			scopes: scopes.scopes,
		});
	}

	const terminal =
		status !== undefined &&
		["completed", "expired", "cancelled"].includes(status.status);

	return (
		<ConsoleSection
			id="connect"
			title="Connection"
			description="The credential is entered on the relay's loopback page. Isolate stores an opaque keychain item name, scopes and metadata only."
			action={
				connection !== null ? (
					started ? null : (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setStarted(true)}
						>
							<KeyIcon />
							Reconnect
						</Button>
					)
				) : null
			}
		>
			{connection !== null && !started ? (
				<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
						<StatusMark status={connection.status} />
						<span className="text-sm text-ink">{connection.displayName}</span>
						<span className="text-xs text-ink-muted">
							on {connection.relayName}
						</span>
						<span className="font-mono text-[11px] text-ink-muted">
							{AUTH_KIND_LABELS[connection.authKind]}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
						<span>
							Verified{" "}
							{connection.lastValidatedAt ? (
								<RelativeTime value={connection.lastValidatedAt} />
							) : (
								"never"
							)}
						</span>
						<span>
							Last used{" "}
							{connection.lastUsedAt ? (
								<RelativeTime value={connection.lastUsedAt} />
							) : (
								"never"
							)}
						</span>
					</div>
				</div>
			) : null}

			{connection !== null && !started ? (
				<ConsoleNote role="note" className="mt-3">
					Verification is pending until the connector verify route lands; the
					server will perform one bounded read. Reconnecting repeats the pairing
					flow with a new key and keeps this display name.
				</ConsoleNote>
			) : null}

			{!canManage ? (
				<ConsoleNote role="note">
					Your role can read this integration but not connect it. Owners and
					admins connect sources.
				</ConsoleNote>
			) : entry.pairingMode === "github_app" ? (
				<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
					<p className="max-w-[60ch] text-xs leading-5 text-ink-secondary">
						GitHub is authorized by the Isolate GitHub App, not a relay-held
						provider key. Install the App and import repositories from the
						repository surface.
					</p>
					<div className="flex gap-2">
						<Button asChild size="sm">
							<Link to="/repositories" search={{ q: "" }}>
								Open repositories
								<ArrowRightIcon />
							</Link>
						</Button>
						<Button asChild size="sm" variant="outline">
							<a href="/api/github/install">Install App</a>
						</Button>
					</div>
				</div>
			) : activeRelays.length === 0 ? (
				<div className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
					<p className="text-xs leading-5 text-ink-secondary">
						A connector needs an active relay to hold its credential. Register
						and start a relay first.
					</p>
					<Button asChild size="sm">
						<Link to="/integrations" search={{ tab: "relays" }}>
							Register a relay
							<ArrowRightIcon />
						</Link>
					</Button>
				</div>
			) : pairing === null ? (
				<form onSubmit={onSubmit} className="space-y-4" noValidate>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="pairing-relay">Relay</Label>
							<select
								id="pairing-relay"
								name="relayId"
								className={SELECT_CLASS}
								required
								defaultValue={activeRelays[0]?.id}
							>
								{activeRelays.map((relay) => (
									<option key={relay.id} value={relay.id}>
										{relay.displayName}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="pairing-display-name">Display name</Label>
							<Input
								id="pairing-display-name"
								name="displayName"
								required
								maxLength={100}
								autoComplete="off"
								defaultValue={entry.label}
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="pairing-credential-ref">Keychain item name</Label>
						<Input
							id="pairing-credential-ref"
							name="credentialRef"
							required
							maxLength={200}
							autoComplete="off"
							spellCheck={false}
							defaultValue={`isolate/${entry.id}/default`}
							aria-describedby="pairing-credential-ref-hint"
						/>
						<p
							id="pairing-credential-ref-hint"
							className="text-xs leading-5 text-ink-muted"
						>
							The name the relay uses for its encrypted local store. Never paste
							the provider key here; the key goes on the relay page.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="pairing-scopes">Scopes (optional)</Label>
						<Input
							id="pairing-scopes"
							name="scopes"
							autoComplete="off"
							spellCheck={false}
							placeholder="read:events read:projects"
						/>
					</div>
					<ConsoleNote role="note" icon={LockIcon}>
						{entry.credentialHint}
					</ConsoleNote>
					<div className="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={create.isPending}>
							<KeyIcon />
							{create.isPending ? "Starting…" : "Connect securely"}
						</Button>
						<span className="text-xs text-ink-muted">
							Auth: {AUTH_KIND_LABELS[entry.defaultAuthKind]}
						</span>
					</div>
				</form>
			) : (
				<div className="space-y-4 border-y border-line-subtle py-4">
					<div className="flex flex-wrap items-center gap-3">
						<StatusMark
							status={
								status?.status === "completed"
									? "connected"
									: status?.status === "expired" ||
											status?.status === "cancelled"
										? "expired"
										: "pending"
							}
							label={
								status === undefined
									? "Starting pairing…"
									: PAIRING_STATUS_LABELS[status.status]
							}
						/>
						<span className="text-xs text-ink-muted">
							Code expires{" "}
							<RelativeTime value={status?.expiresAt ?? pairing.expiresAt} />
						</span>
					</div>
					<div className="space-y-1.5">
						<p className="text-xs font-medium text-ink-muted">
							Relay page (served by 127.0.0.1)
						</p>
						<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
							<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
								{pairing.localUrl}
							</code>
							<CopyButton value={pairing.localUrl} label="Copy relay URL" />
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button asChild size="sm">
							<a href={pairing.localUrl} target="_blank" rel="noreferrer">
								<ExternalIcon />
								Open relay page
							</a>
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={terminal || cancel.isPending}
							onClick={() => cancel.mutate(pairing.pairingId)}
						>
							Cancel pairing
						</Button>
						{status?.status === "completed" ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setPairing(null);
									setStarted(false);
								}}
							>
								Done
							</Button>
						) : null}
					</div>
					<ConsoleNote role="note">
						If the page does not open, start the relay and confirm
						<code className="mx-1 font-mono">127.0.0.1:47821</code> is
						listening. Codes are one-time and last ten minutes.
					</ConsoleNote>
				</div>
			)}

			{error ? (
				<p
					role="alert"
					className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			) : null}
		</ConsoleSection>
	);
}
