import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { RefreshIcon, WarningIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { rotateDevice, toDeviceApiError } from "../api";
import type { DeviceView, IssuedDeviceToken } from "../contracts";
import { TokenReveal } from "./token-reveal";

/**
 * Rotates one device token. The previous token stops authenticating on the
 * next claim; the replacement is shown exactly once.
 */
export function RotateDeviceDialog({
	device,
	open,
	onOpenChange,
	onRotated,
}: {
	device: DeviceView | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRotated: () => void;
}) {
	const [issued, setIssued] = useState<IssuedDeviceToken | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (deviceId: string) => rotateDevice(deviceId),
		// The response carries the one-time token; never keep it in the cache.
		gcTime: 0,
		onSuccess: (result) => {
			setIssued(result);
			onRotated();
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});

	function handleOpenChange(next: boolean) {
		if (!next) {
			setIssued(null);
			setError(null);
			mutation.reset();
		}
		onOpenChange(next);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Rotate device token</DialogTitle>
					<DialogDescription>
						A new token replaces the current one for{" "}
						{device?.displayName ?? "this device"} immediately.
					</DialogDescription>
				</DialogHeader>
				{issued ? (
					<TokenReveal issued={issued} />
				) : (
					<div className="space-y-4">
						<div className="flex items-start gap-2 rounded-md border border-warning/35 bg-warning/10 p-3 text-warning">
							<WarningIcon size={16} className="mt-0.5 shrink-0" />
							<p className="text-xs leading-5">
								The current token stops authenticating at once. Update the
								device daemon with the new token; it is shown only once.
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
							<Button
								type="button"
								disabled={mutation.isPending || device === null}
								onClick={() => {
									if (device === null) return;
									setError(null);
									mutation.mutate(device.id);
								}}
							>
								<RefreshIcon />
								{mutation.isPending ? "Rotating…" : "Rotate token"}
							</Button>
						</DialogFooter>
					</div>
				)}
				{issued ? (
					<DialogFooter>
						<Button type="button" onClick={() => handleOpenChange(false)}>
							Done
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
