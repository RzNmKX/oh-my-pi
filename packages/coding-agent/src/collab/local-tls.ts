import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface LocalTlsCertificate {
	cert: string;
	key: string;
	generated: boolean;
}

export async function loadOrCreateLocalTlsCertificate(hosts: string[]): Promise<LocalTlsCertificate> {
	const dir = path.join(getAgentDir(), "collab-web");
	const certPath = path.join(dir, "local-cert.pem");
	const keyPath = path.join(dir, "local-key.pem");
	try {
		const [cert, key] = await Promise.all([Bun.file(certPath).text(), Bun.file(keyPath).text()]);
		return { cert, key, generated: false };
	} catch {}

	await fs.mkdir(dir, { recursive: true });
	const configPath = path.join(dir, "local-cert.cnf");
	await Bun.write(configPath, opensslConfig(hosts));
	const proc = Bun.spawn(
		[
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"30",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-config",
			configPath,
			"-extensions",
			"v3_req",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (exitCode !== 0) {
		throw new Error(`openssl failed to create local HTTPS certificate: ${stderr.trim()}`);
	}
	const [cert, key] = await Promise.all([Bun.file(certPath).text(), Bun.file(keyPath).text()]);
	return { cert, key, generated: true };
}

export function localNetworkHosts(): string[] {
	const hosts = ["localhost", "127.0.0.1"];
	for (const values of Object.values(os.networkInterfaces())) {
		for (const value of values ?? []) {
			if (value.family === "IPv4" && !value.internal) hosts.push(value.address);
		}
	}
	return hosts;
}

function opensslConfig(hosts: string[]): string {
	const uniqueHosts = [...new Set(hosts.filter(host => host.length > 0))];
	const altNames = uniqueHosts
		.map((host, index) => `${isIpv4(host) ? "IP" : "DNS"}.${index + 1} = ${host}`)
		.join("\n");
	return `[req]
default_bits = 2048
prompt = no
distinguished_name = dn

[dn]
CN = ${uniqueHosts[0] ?? "localhost"}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${altNames}
`;
}

function isIpv4(host: string): boolean {
	const parts = host.split(".");
	return parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) <= 255);
}
