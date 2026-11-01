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
import { revokeDevice, toDeviceApiError } from "../api";
import type { DeviceView } from "../contracts";

/**
 * Revocation is irreversible for the current token and stops the device's
 * connector calls. Confirmation is an alert dialog, never a one-click action.
 */
export function RevokeDeviceDialog({
	device,
	open,
	onOpenChange,
	onRevoked,
}: {
	device: DeviceView | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRevoked: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (deviceId: string) => revokeDevice(deviceId),
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
					<AlertDialogTitle>Revoke this device?</AlertDialogTitle>
					<AlertDialogDescription>
						{device?.displayName ?? "This device"} will stop authenticating
						immediately. Its connector credentials stay in the device keychain
						until the daemon deletes them.
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
						Keep device
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={mutation.isPending || device === null}
						onClick={(event) => {
							event.preventDefault();
							if (device === null) return;
							setError(null);
							mutation.mutate(device.id);
						}}
					>
						<TrashIcon />
						{mutation.isPending ? "Revoking…" : "Revoke device"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
