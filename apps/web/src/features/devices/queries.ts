import { queryOptions } from "@tanstack/react-query";
import { listConnectorCredentials, listDevices } from "./api";

export const deviceKeys = {
	all: ["devices"] as const,
	list: ["devices", "list"] as const,
	connectors: ["connectors", "list"] as const,
};

export const deviceListOptions = () =>
	queryOptions({
		queryKey: deviceKeys.list,
		queryFn: () => listDevices(),
		staleTime: 10_000,
		retry: false,
	});

export const connectorListOptions = () =>
	queryOptions({
		queryKey: deviceKeys.connectors,
		queryFn: () => listConnectorCredentials(),
		staleTime: 10_000,
		retry: false,
	});
