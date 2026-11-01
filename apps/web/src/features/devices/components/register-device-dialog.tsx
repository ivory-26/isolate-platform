import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CpuIcon } from "@/components/icons";
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
import { registerDevice, toDeviceApiError } from "../api";
import { type IssuedDeviceToken, validateDeviceName } from "../contracts";
import { TokenReveal } from "./token-reveal";

/**
 * Registers one device and reveals its token exactly once. The token is held
 * in local state and cleared on close; it never enters the query cache.
 */
export function RegisterDeviceDialog({
	open,
	onOpenChange,
	onRegistered,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRegistered: () => void;
}) {
	const [issued, setIssued] = useState<IssuedDeviceToken | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (displayName: string) => registerDevice(displayName),
		// The response carries the one-time token; never keep it in the cache.
		gcTime: 0,
		onSuccess: (result) => {
			setIssued(result);
			onRegistered();
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

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mutation.isPending) return;
		setError(null);
		const parsed = validateDeviceName(
			String(new FormData(event.currentTarget).get("displayName") ?? ""),
		);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		mutation.mutate(parsed.value);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Register a device</DialogTitle>
					<DialogDescription>
						A device runs connector calls locally with its own keychain. The
						server stores a hash of the token, never the token or a vendor key.
					</DialogDescription>
				</DialogHeader>
				{issued ? (
					<TokenReveal issued={issued} />
				) : (
					<form onSubmit={handleSubmit} className="space-y-4" noValidate>
						<div className="space-y-1.5">
							<Label htmlFor="device-display-name">Device name</Label>
							<Input
								id="device-display-name"
								name="displayName"
								required
								maxLength={100}
								autoComplete="off"
								placeholder="laptop-keychain"
								aria-describedby="device-display-name-hint"
							/>
							<p
								id="device-display-name-hint"
								className="text-xs leading-5 text-ink-muted"
							>
								1–100 characters. Names are unique in this organization.
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
								<CpuIcon />
								{mutation.isPending ? "Registering…" : "Register device"}
							</Button>
						</DialogFooter>
					</form>
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
