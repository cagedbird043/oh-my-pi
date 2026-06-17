/**
 * Offline stand-in for the public collab relay (`wss://my.omp.sh`).
 *
 * Speaks the exact relay contract the real clients expect:
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - The host creates the room; a second host is rejected with close 4009 and
 *   a guest joining a missing room with close 4004.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N
 *   targets that guest only — forwarded unchanged either way.
 * - Guest binary frames: the first 4 envelope bytes are rewritten to the
 *   sender's peerId, then forwarded to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001
 *   and the room is garbage-collected.
 *
 * The relay never sees plaintext: payloads stay sealed end to end.
 */
import { rewriteEnvelopePeer, unpackEnvelope } from "../src/lib/link";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

const DEFAULT_PORT = 7466;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface LocalRelay {
	/** ws://localhost:<port> — append `/r/<roomId>?role=…` to connect. */
	url: string;
	/** Closes every room and stops the server. Idempotent. */
	stop(): void;
}

export function startLocalRelay(port = 0, tls?: { key?: string; cert?: string }): LocalRelay {
	const rooms = new Map<string, Room>();

	const server = Bun.serve({
		port,
		...(tls?.key && tls?.cert
			? {
					tls: {
						key: Bun.file(tls.key),
						cert: Bun.file(tls.cert),
					},
				}
			: {}),
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) {
				return new Response("not found", { status: 404 });
			}
			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return; // clients never send TEXT
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(envelope.peerId)?.send(message);
					}
					return;
				}
				if (message.byteLength < 4) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					// Rejected second host: the live room is not ours to tear down.
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						guest.send(closure);
						guest.close(4001, "room closed");
					}
					room.guests.clear();
					return;
				}
				if (room.guests.delete(peerId)) {
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
				}
			},
		},
	});

	const isTls = !!(tls?.key && tls?.cert);
	return {
		url: `${isTls ? "wss" : "ws"}://localhost:${server.port}`,
		stop(): void {
			for (const room of rooms.values()) {
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}
function parseArgs(argv: readonly string[]): {
	port: number;
	tlsKey?: string;
	tlsCert?: string;
} {
	let rawPort: string | undefined;
	let tlsKey: string | undefined;
	let tlsCert: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") rawPort = argv[i + 1];
		else if (arg.startsWith("--port=")) rawPort = arg.slice("--port=".length);
		else if (arg === "--tls-key") tlsKey = argv[i + 1];
		else if (arg.startsWith("--tls-key=")) tlsKey = arg.slice("--tls-key=".length);
		else if (arg === "--tls-cert") tlsCert = argv[i + 1];
		else if (arg.startsWith("--tls-cert=")) tlsCert = arg.slice("--tls-cert=".length);
	}
	const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		console.error(`local-relay: invalid --port ${rawPort}`);
		process.exit(1);
	}
	return { port, tlsKey, tlsCert };
}

if (import.meta.main) {
	const config = parseArgs(Bun.argv.slice(2));
	const relay = startLocalRelay(config.port, { key: config.tlsKey, cert: config.tlsCert });
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		relay.stop();
		process.exit(0);
	};
	console.log(`local collab relay listening on ${relay.url}`);
	console.log("connect with /r/<roomId>?role=host|guest; Ctrl+C stops the relay");
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
