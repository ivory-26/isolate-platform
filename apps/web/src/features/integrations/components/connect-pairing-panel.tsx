import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
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
import { WorkspaceHashLink } from "@/components/shell/workspace-hash-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	AUTH_KIND_LABELS,
	type DeviceView,
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
import { defaultRelayId, relayChoices } from "../relay-selection";
import {
	autoVerificationCredentialId,
	verificationFailureMessage,
	verificationIncompleteMessage,
	verificationRejectionMessage,
	verificationStatusLabel,
} from "../verification";
import { verifyConnectorCredentialAction } from "../verification.functions";
import { RelayPicker } from "./relay-picker";

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
	const [pairingRelayId, setPairingRelayId] = useState<string | null>(null);
	// A manual relay choice wins over the heartbeat-derived default. Only the
	// absence of a choice lets polling/refetch move the selection.
	const [selectedRelayId, setSelectedRelayId] = useState<string | null>(null);
	// Null until the client measures "now", so the server render asserts no
	// freshness instead of disagreeing at hydration.
	const [nowMs, setNowMs] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [started, setStarted] = useState(false);
	const [pairingCompleted, setPairingCompleted] = useState(false);

	const relayChoicesView = relayChoices(activeRelays, nowMs);
	const proposedRelayId = defaultRelayId(relayChoicesView);
	const chosenRelayId =
		selectedRelayId !== null &&
		activeRelays.some((relay) => relay.id === selectedRelayId)
			? selectedRelayId
			: proposedRelayId;
	const pairingRelayName =
		pairingRelayId === null
			? null
			: (relays.find((relay) => relay.id === pairingRelayId)?.displayName ??
				null);

	// Re-evaluate heartbeat freshness while the form is visible; once a pairing
	// exists the reported relay is fixed and the picker is gone.
	useEffect(() => {
		if (pairing !== null) return;
		const update = () => setNowMs(Date.now());
		update();
		if (activeRelays.length === 0) return;
		const timer = setInterval(update, 30_000);
		return () => clearInterval(timer);
	}, [pairing, activeRelays.length]);

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

	// Auto-verify once when pairing stores a credential id. The guard survives
	// React's development double-effect so exactly one bounded read is asked for.
	const autoVerified = useRef<string | null>(null);
	const verify = useMutation({
		mutationFn: (credentialId: string) =>
			verifyConnectorCredentialAction(credentialId),
		onSettled: async () => {
			await queryClient.invalidateQueries({
				queryKey: integrationKeys.all,
			});
		},
	});
	const verifyCredential = verify.mutate;

	const create = useMutation({
		mutationFn: (input: CreatePairingInput) => createPairing(input),
		onSuccess: (result, input) => {
			setPairing(result);
			setPairingRelayId(input.relayId);
			setStarted(false);
			setPairingCompleted(false);
			setError(null);
			autoVerified.current = null;
			verify.reset();
		},
		onError: (cause) => setError(pairingErrorMessage(cause)),
	});
	const cancel = useMutation({
		mutationFn: (pairingId: string) => cancelPairing(pairingId),
		onSuccess: () => {
			setPairing(null);
			setPairingRelayId(null);
			setError(null);
		},
		onError: (cause) => setError(pairingErrorMessage(cause)),
	});

	useEffect(() => {
		if (status?.status !== "completed" || pairingCompleted) return;
		setPairingCompleted(true);
		void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
		onConnected();
		const credentialId = autoVerificationCredentialId(
			status,
			autoVerified.current,
		);
		if (credentialId !== null) {
			autoVerified.current = credentialId;
			verifyCredential(credentialId);
		}
	}, [status, pairingCompleted, onConnected, queryClient, verifyCredential]);

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (create.isPending || chosenRelayId === null) return;
		setError(null);
		const form = new FormData(event.currentTarget);
		// The keychain item name is an implementation detail. Generate an
		// opaque, unique reference; the user only names the connection and
		// enters the provider credential on the relay's loopback page.
		const suffix =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID().slice(0, 8)
				: `${Date.now().toString(36)}`;
		create.mutate({
			relayId: chosenRelayId,
			connectorId: entry.id,
			displayName: String(form.get("displayName") ?? ""),
			authKind: entry.defaultAuthKind,
			credentialRef: `isolate/${entry.id}/${suffix}`,
			scopes: [],
		});
	}

	const terminal =
		status !== undefined &&
		["completed", "expired", "cancelled"].includes(status.status);
	const pairingLabel =
		status === undefined
			? "Starting pairing…"
			: status.status === "completed"
				? "Stored on relay — verification pending"
				: PAIRING_STATUS_LABELS[status.status];
	const verificationOutcome = verify.data;

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
						<StatusMark
							status={connection.status}
							label={verificationStatusLabel(connection.status)}
						/>
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
				pairingCompleted ? (
					verify.isPending ? (
						<ConsoleNote tone="warning" role="status" className="mt-3">
							Stored on relay. Running one bounded verification read…
						</ConsoleNote>
					) : verificationOutcome?.ok === true &&
						verificationOutcome.value.status === "active" ? (
						<ConsoleNote role="status" className="mt-3">
							Stored on relay and verified. The server reported the connection
							active; details are in the Verification section below.
						</ConsoleNote>
					) : verificationOutcome?.ok === true &&
						verificationOutcome.value.status === "invalid" ? (
						<ConsoleNote tone="danger" role="alert" className="mt-3">
							Stored on relay but rejected.{" "}
							{verificationRejectionMessage(
								verificationOutcome.value.reasonCode,
							)}{" "}
							Reconnect with valid credentials, then verify again.
						</ConsoleNote>
					) : verificationOutcome?.ok === true &&
						verificationOutcome.value.status === "pending_validation" ? (
						<ConsoleNote tone="warning" role="status" className="mt-3">
							Stored on relay.{" "}
							{verificationIncompleteMessage(
								verificationOutcome.value.reasonCode,
							)}
						</ConsoleNote>
					) : verificationOutcome?.ok === false ? (
						<ConsoleNote tone="danger" role="alert" className="mt-3">
							Stored on relay but not verified.{" "}
							{verificationFailureMessage(verificationOutcome.error.code)} Run{" "}
							<WorkspaceHashLink
								hash="verification"
								className="font-medium underline underline-offset-2"
							>
								Verify connection
							</WorkspaceHashLink>{" "}
							in the Verification section below.
						</ConsoleNote>
					) : (
						<ConsoleNote tone="warning" role="status" className="mt-3">
							Stored on relay. The credential is not verified yet. Run{" "}
							<WorkspaceHashLink
								hash="verification"
								className="font-medium underline underline-offset-2"
							>
								Verify connection
							</WorkspaceHashLink>{" "}
							in the Verification section below.
						</ConsoleNote>
					)
				) : (
					<ConsoleNote role="note" className="mt-3">
						The connection is stored on the relay but is not verified until the
						bounded read succeeds. A pending or invalid connection is not
						production-ready. Reconnecting repeats the pairing flow with a new
						key and keeps this display name.
					</ConsoleNote>
				)
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
							<a
								href="/api/github/install"
								target="_blank"
								rel="noopener noreferrer"
							>
								Install App
							</a>
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
						<RelayPicker
							relays={activeRelays}
							selectedId={chosenRelayId}
							onSelect={setSelectedRelayId}
							nowMs={nowMs}
						/>
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
					<ConsoleNote role="note" icon={KeyIcon}>
						You will enter the provider credential on the relay&apos;s one-time
						loopback page. Isolate generates the local store reference and never
						sees the key.
					</ConsoleNote>
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
									? "pending_validation"
									: status?.status === "expired" ||
											status?.status === "cancelled"
										? "expired"
										: "pending"
							}
							label={pairingLabel}
						/>
						<span className="text-xs text-ink-muted">
							Code expires{" "}
							<RelativeTime value={status?.expiresAt ?? pairing.expiresAt} />
						</span>
						{pairingRelayName === null ? null : (
							<span className="text-xs text-ink-muted">
								Code is bound to {pairingRelayName}
							</span>
						)}
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
									setPairingRelayId(null);
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
