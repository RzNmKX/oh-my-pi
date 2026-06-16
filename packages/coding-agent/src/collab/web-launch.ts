import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodeEmbeddedCollabWebArchive, extractEmbeddedCollabWeb } from "./embedded-web-client";
import { loadOrCreateLocalTlsCertificate, localNetworkHosts } from "./local-tls";
import { rewriteEnvelopePeer, unpackEnvelope } from "./protocol";
import embeddedCollabWebTxt from "./web-client.generated.txt";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const PAIR_CODE_BYTES = 4;

// Compiled binaries and the prepacked npm bundle ship no collab-web source on
// disk, so they must serve the embedded archive rather than build from source.
const IS_PREBUILT =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED || process.env.PI_BUNDLED || Bun.env.PI_BUNDLED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

interface LocalTlsOptions {
	cert: string;
	key: string;
	generated?: boolean;
}

export interface CollabWebLaunchOptions {
	host?: string;
	port?: number;
	publicUrl?: string;
	certPath?: string;
	keyPath?: string;
	collabWebDir?: string;
}

export interface PublishedCollabWebLink {
	webLink: string;
	pairLink: string;
	pairCode: string;
}

export interface CollabWebLaunch {
	webUrl: string;
	relayUrl: string;
	generatedLocalCert: boolean;
	publishLink(collabLink: string): PublishedCollabWebLink;
	stop(): Promise<void>;
}

export async function startCollabWebLaunch(options: CollabWebLaunchOptions = {}): Promise<CollabWebLaunch> {
	const build = await buildCollabWeb(options.collabWebDir);
	const rooms = new Map<string, Room>();
	const pairLinks = new Map<string, string>();
	let server: Bun.Server<SocketData> | undefined;
	let tls: LocalTlsOptions | undefined;
	try {
		tls = await readTlsOptions(options);
		server = Bun.serve<SocketData>({
			hostname: options.host ?? DEFAULT_HOST,
			port: options.port ?? DEFAULT_PORT,
			...(tls ? { tls } : {}),
			async fetch(req, srv): Promise<Response | undefined> {
				const url = new URL(req.url);
				if (url.pathname === "/healthz") return new Response("ok\n");

				const role = url.searchParams.get("role");
				const roomMatch = ROOM_PATH_RE.exec(url.pathname);
				if (roomMatch && (role === "host" || role === "guest")) {
					const data: SocketData = { roomId: roomMatch[1]!, role, peerId: 0 };
					if (srv.upgrade(req, { data })) return undefined;
					return new Response("websocket upgrade required", { status: 426 });
				}

				const pairMatch = /^\/p\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
				if (pairMatch) {
					const collabLink = pairLinks.get(pairMatch[1]!);
					if (!collabLink) return new Response("pair code not found", { status: 404 });
					return Response.redirect(`/#${collabLink}`, 302);
				}

				return serveBuiltAsset(build, url.pathname);
			},
			websocket: {
				open(ws): void {
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
				message(ws, message): void {
					if (typeof message === "string") return;
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
				close(ws): void {
					const { roomId, role, peerId } = ws.data;
					const room = rooms.get(roomId);
					if (!room) return;
					if (role === "host") {
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
	} catch (error) {
		await fs.rm(build.outdir, { recursive: true, force: true });
		throw error;
	}
	if (!server) {
		await fs.rm(build.outdir, { recursive: true, force: true });
		throw new Error("collab web server failed to start");
	}
	const serverPort = server.port;
	if (serverPort === undefined) {
		await fs.rm(build.outdir, { recursive: true, force: true });
		throw new Error("collab web server did not expose a port");
	}

	const webUrl = normalizePublicUrl(options.publicUrl ?? derivePublicUrl(options, serverPort, tls !== undefined));
	const relayUrl = relayUrlForWebUrl(webUrl);
	return {
		webUrl,
		relayUrl,
		generatedLocalCert: tls?.generated === true,
		publishLink(collabLink: string): PublishedCollabWebLink {
			let pairCode = randomPairCode();
			while (pairLinks.has(pairCode)) pairCode = randomPairCode();
			pairLinks.set(pairCode, collabLink);
			return {
				webLink: `${webUrl}/#${collabLink}`,
				pairLink: `${webUrl}/p/${pairCode}`,
				pairCode,
			};
		},
		async stop(): Promise<void> {
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
			await fs.rm(build.outdir, { recursive: true, force: true });
		},
	};
}

interface BuildOutput {
	outdir: string;
	indexPath: string;
}

async function buildCollabWeb(collabWebDir?: string): Promise<BuildOutput> {
	// Compiled binaries (and the prepacked npm bundle) ship no collab-web source
	// on disk, so they serve the archive embedded at build time. The dev tree
	// keeps the empty placeholder and builds from source below.
	const embedded = decodeEmbeddedCollabWebArchive(embeddedCollabWebTxt);
	if (embedded) {
		const outdir = await extractEmbeddedCollabWeb(embedded);
		return { outdir, indexPath: path.join(outdir, "index.html") };
	}
	if (IS_PREBUILT) {
		throw new Error(
			"Embedded collab-web bundle missing. Rebuild the omp binary with embedded collab-web assets " +
				"(scripts/generate-collab-web-bundle.ts --generate).",
		);
	}
	return buildCollabWebFromSource(collabWebDir ?? path.resolve(import.meta.dir, "../../../collab-web"));
}

async function buildCollabWebFromSource(collabWebDir: string): Promise<BuildOutput> {
	const indexPath = path.join(collabWebDir, "index.html");
	if (!(await Bun.file(indexPath).exists())) {
		throw new Error(`collab-web index not found at ${indexPath}`);
	}
	const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-web-"));
	const result = await Bun.build({
		entrypoints: [indexPath],
		outdir,
		minify: true,
		naming: "[hash].[ext]",
	});
	if (!result.success) {
		await fs.rm(outdir, { recursive: true, force: true });
		const details = result.logs.map(log => String(log)).join("\n");
		throw new Error(details ? `collab-web build failed:\n${details}` : "collab-web build failed");
	}
	const html = result.outputs.find(output => output.path.endsWith(".html"));
	if (!html) {
		await fs.rm(outdir, { recursive: true, force: true });
		throw new Error("collab-web build produced no HTML entry");
	}
	return { outdir, indexPath: html.path };
}

export function shouldUseGeneratedLocalTls(options: CollabWebLaunchOptions): boolean {
	if (options.certPath !== undefined || options.keyPath !== undefined) return false;
	return options.host === "0.0.0.0" || options.host === "::" || options.publicUrl?.startsWith("https://") === true;
}

async function readTlsOptions(options: CollabWebLaunchOptions): Promise<LocalTlsOptions | undefined> {
	if (!shouldUseGeneratedLocalTls(options) && !options.certPath && !options.keyPath) return undefined;
	if (!options.certPath && !options.keyPath) return loadOrCreateLocalTlsCertificate(localNetworkHosts());
	if (!options.certPath || !options.keyPath) throw new Error("--web-cert and --web-key must be provided together");
	const [cert, key] = await Promise.all([Bun.file(options.certPath).text(), Bun.file(options.keyPath).text()]);
	return { cert, key };
}

async function serveBuiltAsset(build: BuildOutput, requestPath: string): Promise<Response> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(requestPath);
	} catch {
		return new Response("bad path", { status: 400 });
	}
	const relative = decoded === "/" ? path.basename(build.indexPath) : decoded.replace(/^\/+/, "");
	const candidate = path.resolve(build.outdir, relative);
	const root = path.resolve(build.outdir);
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
		return new Response("not found", { status: 404 });
	}
	const file = Bun.file(candidate);
	if (!(await file.exists())) return new Response("not found", { status: 404 });
	return new Response(file);
}

function derivePublicUrl(options: CollabWebLaunchOptions, port: number, https: boolean): string {
	const scheme = https ? "https" : "http";
	const host = publicHostForBindHost(options.host ?? DEFAULT_HOST);
	return `${scheme}://${host}:${port}`;
}

function publicHostForBindHost(host: string): string {
	if (host !== "0.0.0.0" && host !== "::") return host;
	const candidates: string[] = [];
	for (const values of Object.values(os.networkInterfaces())) {
		for (const value of values ?? []) {
			if (value.family === "IPv4" && !value.internal) candidates.push(value.address);
		}
	}
	// Prefer a real RFC-1918 LAN address (reachable from a phone on the same
	// Wi-Fi) over CGNAT/Tailscale (100.64/10) or other non-internal addresses,
	// which are picked up first on some machines. Override with --web-host or
	// --web-url to force a specific interface (e.g. a Tailscale IP).
	return candidates.find(isRfc1918Address) ?? candidates[0] ?? "localhost";
}

function isRfc1918Address(ip: string): boolean {
	const match = /^(\d{1,3})\.(\d{1,3})\./.exec(ip);
	if (!match) return false;
	const a = Number(match[1]);
	const b = Number(match[2]);
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	return false;
}

function normalizePublicUrl(raw: string): string {
	const url = new URL(raw);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function relayUrlForWebUrl(webUrl: string): string {
	const url = new URL(webUrl);
	if (url.protocol === "https:") return `wss://${url.host}`;
	if (url.protocol === "http:") return `ws://${url.host}`;
	throw new Error(`--web-url must use http:// or https://, got ${url.protocol}`);
}

function randomPairCode(): string {
	const bytes = new Uint8Array(PAIR_CODE_BYTES);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url").toLowerCase();
}
