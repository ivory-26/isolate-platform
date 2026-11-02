import { queryOptions } from "@tanstack/react-query";
import {
	getIntegration,
	listDeliveries,
	listIntegrations,
} from "./integrations.functions";

export const integrationKeys = {
	all: ["integrations"] as const,
	list: ["integrations", "list"] as const,
	detail: (connectorId: string) =>
		["integrations", "detail", connectorId] as const,
	deliveries: ["integrations", "deliveries"] as const,
};

export const integrationsOptions = () =>
	queryOptions({
		queryKey: integrationKeys.list,
		queryFn: () => listIntegrations(),
		staleTime: 10_000,
		retry: false,
	});

export const integrationOptions = (connectorId: string) =>
	queryOptions({
		queryKey: integrationKeys.detail(connectorId),
		queryFn: () => getIntegration({ data: { connectorId } }),
		staleTime: 10_000,
		retry: false,
	});

export const integrationDeliveriesOptions = (connectorId?: string) =>
	queryOptions({
		queryKey: [...integrationKeys.deliveries, connectorId ?? "all"],
		queryFn: () =>
			listDeliveries({
				data: connectorId === undefined ? {} : { connectorId },
			}),
		staleTime: 10_000,
		retry: false,
	});
