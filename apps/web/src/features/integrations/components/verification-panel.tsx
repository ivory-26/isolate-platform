import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IntegrationConnection } from "../contracts";
import { integrationKeys } from "../queries";
import {
	type ConnectorVerificationResult,
	verificationFailure,
} from "../verification";
import { verifyConnectorCredentialAction } from "../verification.functions";
import { VerificationControls } from "./verification-controls";

/**
 * Explicit verify action for an existing connection.
 *
 * Visible only to a role that can manage the connector. The mutation always
 * invalidates the detail and list reads on completion, so a stored status
 * change from the relay is reflected even when the request itself fails.
 */
export function VerificationPanel({
	connectorId,
	connection,
	canManage,
}: {
	connectorId: string;
	connection: IntegrationConnection | null;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const [outcome, setOutcome] = useState<ConnectorVerificationResult | null>(
		null,
	);
	const verify = useMutation({
		mutationFn: (credentialId: string) =>
			verifyConnectorCredentialAction(credentialId),
		onMutate: () => setOutcome(null),
		onSuccess: (result) => setOutcome(result),
		onError: () => setOutcome(verificationFailure("UNAVAILABLE")),
		onSettled: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: integrationKeys.detail(connectorId),
				}),
				queryClient.invalidateQueries({ queryKey: integrationKeys.list }),
			]);
		},
	});

	if (connection === null || !canManage) return null;

	return (
		<VerificationControls
			status={connection.status}
			storedVerifiedAt={connection.lastValidatedAt}
			outcome={outcome}
			isPending={verify.isPending}
			onVerify={() => verify.mutate(connection.id)}
		/>
	);
}
