import { afterEach, describe, expect, it } from "bun:test";
import { loadOrCreateLocalTlsCertificate, localNetworkHosts } from "@oh-my-pi/pi-coding-agent/collab/local-tls";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

// Minimal TLS relay that accepts the room upgrade — enough to exercise the TLS
// handshake the `--web --web-host 0.0.0.0` host performs against its own
// self-signed certificate.
let server: Bun.Server<undefined> | undefined;
let socket: CollabSocket | undefined;

afterEach(() => {
	socket?.close();
	socket = undefined;
	server?.stop(true);
	server = undefined;
});

describe("CollabSocket against a self-signed local relay", () => {
	it("trusts the generated local cert and completes the TLS handshake", async () => {
		// Writes (or reuses) the cert at the well-known path the client reads.
		const tls = await loadOrCreateLocalTlsCertificate(localNetworkHosts());
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: tls.cert, key: tls.key },
			fetch(req, srv): Response | undefined {
				if (srv.upgrade(req)) return undefined;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: { open() {}, message() {}, close() {} },
		});

		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		socket = new CollabSocket({
			wsUrl: `wss://127.0.0.1:${server.port}/r/handshake-room`,
			role: "host",
			key,
		});

		const opened = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for open")), 5_000);
			socket!.onOpen = () => {
				clearTimeout(timer);
				resolve();
			};
			socket!.onClose = (reason, willReconnect) => {
				if (willReconnect) return; // ignore transient retry noise after a successful open
				clearTimeout(timer);
				reject(new Error(`closed before open: ${reason}`));
			};
		});
		socket.connect();

		await expect(opened).resolves.toBeUndefined();
	});
});
