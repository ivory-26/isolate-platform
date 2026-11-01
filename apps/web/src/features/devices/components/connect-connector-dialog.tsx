import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ConnectorsIcon, KeyIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectConnector, toDeviceApiError } from "../api";
import {
	AUTH_KIND_LABELS,
	buildConnectInput,
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_IDS,
	CONNECTOR_LABELS,
	type DeviceView,
} from "../contracts";

const SELECT_CLASS =
	"h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * Connect a vendor. The form submits metadata and an opaque keychain name
 * only; a pasted vendor secret is refused before a request is sent.
 */
export function ConnectConnectorDialog({
	open,
	onOpenChange,
	devices,
	onConnected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	devices: readonly DeviceView[];
	onConnected: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const activeDevices = devices.filter((device) => device.status === "active");
	const defaultDeviceId = activeDevices[0]?.id ?? "";
	const mutation = useMutation({
		mutationFn: connectConnector,
		onSuccess: () => {
			onConnected();
			handleOpenChange(false);
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});

	function handleOpenChange(next: boolean) {
		if (!next) {
			setError(null);
			mutation.reset();
		}
		onOpenChange(next);
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mutation.isPending) return;
		setError(null);
		const form = new FormData(event.currentTarget);
		const built = buildConnectInput({
			deviceId: String(form.get("deviceId") ?? ""),
			connectorId: String(form.get("connectorId") ?? ""),
			displayName: String(form.get("displayName") ?? ""),
			authKind: String(form.get("authKind") ?? ""),
			credentialRef: String(form.get("credentialRef") ?? ""),
			scopesText: String(form.get("scopes") ?? ""),
		});
		if (!built.ok) {
			setError(built.error);
			return;
		}
		mutation.mutate(built.value);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Connect a vendor</DialogTitle>
					<DialogDescription>
						One of the ten supported connectors. Calls run on the selected
						device; Isolate receives neither the vendor key nor its contents.
					</DialogDescription>
				</DialogHeader>
				{activeDevices.length === 0 ? (
					<p
						role="alert"
						className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning"
					>
						Register an active device before connecting a vendor.
					</p>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4" noValidate>
						<div className="flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
							<KeyIcon size={14} className="mt-0.5 shrink-0 text-brand" />
							<p className="leading-5">
								The vendor key stays in the device keychain. Enter the keychain
								item name only — the server stores that name and connector
								metadata, never the secret.
							</p>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="connector-device">Device</Label>
								<select
									id="connector-device"
									name="deviceId"
									className={SELECT_CLASS}
									defaultValue={defaultDeviceId}
									required
								>
									{activeDevices.map((device) => (
										<option key={device.id} value={device.id}>
											{device.displayName}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="connector-id">Connector</Label>
								<select
									id="connector-id"
									name="connectorId"
									className={SELECT_CLASS}
									defaultValue="github"
									required
								>
									{CONNECTOR_IDS.map((id) => (
										<option key={id} value={id}>
											{CONNECTOR_LABELS[id]}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="connector-auth-kind">Authentication</Label>
								<select
									id="connector-auth-kind"
									name="authKind"
									className={SELECT_CLASS}
									defaultValue="api_key"
									required
								>
									{CONNECTOR_AUTH_KINDS.map((kind) => (
										<option key={kind} value={kind}>
											{AUTH_KIND_LABELS[kind]}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="connector-display-name">Display name</Label>
								<Input
									id="connector-display-name"
									name="displayName"
									required
									maxLength={100}
									autoComplete="off"
									placeholder="Team Sentry"
								/>
							</div>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="connector-credential-ref">
								Device keychain name
							</Label>
							<Input
								id="connector-credential-ref"
								name="credentialRef"
								required
								maxLength={200}
								autoComplete="off"
								spellCheck={false}
								placeholder="keychain:isolate/sentry/team"
								aria-describedby="connector-credential-ref-hint"
							/>
							<p
								id="connector-credential-ref-hint"
								className="text-xs leading-5 text-ink-muted"
							>
								The name the daemon uses to read the secret from its own
								keychain. Never paste the vendor key here.
							</p>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="connector-scopes">Scopes (optional)</Label>
							<Input
								id="connector-scopes"
								name="scopes"
								autoComplete="off"
								spellCheck={false}
								placeholder="issues:read events:read"
								aria-describedby="connector-scopes-hint"
							/>
							<p
								id="connector-scopes-hint"
								className="text-xs leading-5 text-ink-muted"
							>
								Space or comma separated provider scopes. Leave blank if the
								connector needs none.
							</p>
						</div>
						{error ? (
							<p
								role="alert"
								className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
							>
								{error}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={mutation.isPending}
								onClick={() => handleOpenChange(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={mutation.isPending}>
								<ConnectorsIcon />
								{mutation.isPending ? "Connecting…" : "Connect connector"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
