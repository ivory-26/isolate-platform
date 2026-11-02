import "@tanstack/react-start/server-only";

/**
 * Relay installer served at `GET /api/install/relay`.
 *
 * The URL embeds no secret: the one-time device token is passed as an argument
 * by the copyable command the browser shows. The script downloads the
 * repository archive, installs the relay's dependencies, writes a private
 * config/env file under `~/.isolate`, and starts the daemon in the foreground.
 *
 * The archive location is deployment-controlled through
 * `ISOLATE_RELAY_ARCHIVE_URL` on the relay machine (https only). The default is
 * the public repository archive; a private/self-hosted operator should point it
 * at their own immutable release tarball.
 */

export const DEFAULT_RELAY_ARCHIVE_URL =
	"https://github.com/ivory-26/isolate-platform/archive/refs/heads/main.tar.gz";

export const RELAY_INSTALL_PATH = "/api/install/relay";

/** https-only archive URL; no credentials, query or fragment. */
export function normalizeRelayArchiveUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:") return null;
		if (url.username !== "" || url.password !== "") return null;
		if (url.search !== "" || url.hash !== "") return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * The installer is intentionally small and auditable. It never prints the
 * token, never uses `set -x`, and writes the token/config with mode 0600.
 */
export function buildRelayInstallScript(
	archiveUrl: string = DEFAULT_RELAY_ARCHIVE_URL,
): string {
	const archive = normalizeRelayArchiveUrl(archiveUrl);
	if (archive === null) {
		throw new Error("Relay archive URL must be https with no credentials");
	}
	return `#!/bin/sh
set -eu

SERVER=""
TOKEN=""
NAME="relay"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--server) SERVER="$2"; shift 2 ;;
		--token) TOKEN="$2"; shift 2 ;;
		--name) NAME="$2"; shift 2 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
	echo "usage: install relay --server <url> --token <token> [--name <name>]" >&2
	exit 2
fi

case "$SERVER" in
	https://*|http://127.0.0.1*|http://localhost*) ;;
	*) echo "server must be https (loopback http is allowed)" >&2; exit 2 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
	echo "curl is required" >&2
	exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
	echo "tar is required" >&2
	exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
	echo "Installing Bun..."
	curl -fsSL https://bun.sh/install | bash
	export PATH="$HOME/.bun/bin:$PATH"
fi

ROOT="$HOME/.isolate/relay"
if [ -n "\${ISOLATE_RELAY_HOME:-}" ]; then
	ROOT="$ISOLATE_RELAY_HOME"
fi
mkdir -p "$ROOT" "$HOME/.isolate"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "Downloading the relay archive..."
curl -fsSL "\${ISOLATE_RELAY_ARCHIVE_URL:-${archive}}" -o "$TMP/repo.tar.gz"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"

SRC="$(find "$TMP" -maxdepth 1 -type d -name 'isolate-platform-*' -print -quit)"
if [ -z "$SRC" ]; then
	echo "The relay archive did not contain the expected directory." >&2
	exit 1
fi

rm -rf "$ROOT/src"
mkdir -p "$ROOT/src"
cp -R "$SRC/." "$ROOT/src/"
cd "$ROOT/src"

echo "Installing relay dependencies..."
bun install --frozen-lockfile

umask 077
CONFIG_FILE="$HOME/.isolate/connectors.json"
ENV_FILE="$HOME/.isolate/relay.env"

cat > "$CONFIG_FILE" <<EOF
{"serverUrl":"$SERVER","deviceTokenEnv":"ISOLATE_DEVICE_TOKEN","pollIntervalMs":2000,"pairing":{"enabled":true,"port":47821,"secretsPath":"$HOME/.isolate/secrets.json"},"vendors":{}}
EOF

cat > "$ENV_FILE" <<EOF
ISOLATE_DEVICE_TOKEN=$TOKEN
ISOLATE_DEVICE_CONFIG=$CONFIG_FILE
EOF

chmod 600 "$CONFIG_FILE" "$ENV_FILE"

echo "Relay installed. Pairing page: http://127.0.0.1:47821"
echo "Starting the relay (Ctrl+C stops it)..."
exec bun --env-file "$ENV_FILE" apps/device-daemon/src/index.ts
`;
}

export function handleRelayInstallRequest(): Response {
	return new Response(buildRelayInstallScript(), {
		status: 200,
		headers: {
			"Content-Type": "text/x-shellscript; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Disposition": "inline; filename=isolate-relay.sh",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
