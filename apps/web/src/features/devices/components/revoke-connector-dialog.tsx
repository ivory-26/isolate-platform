import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { TrashIcon } from "@/components/icons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { revokeConnector, toDeviceApiError } from "../api";
import { type ConnectorCredentialView, connectorLabel } from "../contracts";

/**
 * Disconnecting keeps the metadata row as `revoked`; the secret remains in the
 * device keychain until the daemon deletes it. Confirmation is required.
 */
export function RevokeConnectorDialog({
	credential,
	open,
	onOpenChange,
	onRevoked,
}: {
	credential: ConnectorCredentialView | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRevoked: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (credentialId: string) => revokeConnector(credentialId),
		onSuccess: () => {
			onRevoked();
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

	return (
		<AlertDialog open={open} onOpenChange={handleOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Disconnect this connector?</AlertDialogTitle>
					<AlertDialogDescription>
						{connectorLabel(credential?.connectorId ?? "")} (
						{credential?.displayName ?? "unnamed"}) stops resolving for this
						organization. The metadata row is kept as revoked; the device
						keychain entry is not deleted by the server.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{error ? (
					<p
						role="alert"
						className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
					>
						{error}
					</p>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={mutation.isPending}>
						Keep connected
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={mutation.isPending || credential === null}
						onClick={(event) => {
							event.preventDefault();
							if (credential === null) return;
							setError(null);
							mutation.mutate(credential.id);
						}}
					>
						<TrashIcon />
						{mutation.isPending ? "Disconnecting…" : "Disconnect"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
