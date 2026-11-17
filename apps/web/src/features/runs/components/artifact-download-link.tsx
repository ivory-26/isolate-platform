import { ExternalIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { RunArtifact } from "../contracts";

/**
 * Download control for an artifact whose payload lives in the blob store.
 * Inline artifacts keep their bounded preview and get no link, because there
 * is no separate stored payload to serve.
 */
export function ArtifactDownloadLink({
	artifact,
}: {
	artifact: Pick<RunArtifact, "id" | "isBlob">;
}) {
	if (!artifact.isBlob) return null;
	return (
		<Button asChild variant="outline" size="sm">
			<a
				href={`/api/artifacts/${encodeURIComponent(artifact.id)}`}
				target="_blank"
				rel="noreferrer"
			>
				<ExternalIcon />
				Download payload
			</a>
		</Button>
	);
}
