/**
 * Embedded collab-web archive handling.
 *
 * `web-client.generated.txt` holds the base64 of a gzipped tar of the built
 * collab-web app (`packages/collab-web/dist`). It is populated by
 * `scripts/generate-collab-web-bundle.ts --generate` for compiled binaries and
 * reset to an empty file afterwards, so the dev tree keeps building collab-web
 * from source. Mirrors the stats dashboard embed in `@oh-my-pi/omp-stats`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Decode the generated archive text.
 *
 * Returns `null` when the content is blank or not a raw gzip archive encoded as
 * base64 — notably the empty placeholder checked into the dev tree, which must
 * be treated as "no archive embedded" rather than decoded into garbage bytes.
 */
export function decodeEmbeddedCollabWebArchive(txt: string): Buffer | null {
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archiveBytes = Buffer.from(normalized, "base64");
	if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) return null;
	return archiveBytes;
}

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

/**
 * Extract the embedded collab-web archive into a content-addressed directory
 * under the OS temp dir and return its path. Re-uses an existing extraction
 * (keyed by archive hash) when `index.html` is already present.
 */
export async function extractEmbeddedCollabWeb(archiveBytes: Buffer): Promise<string> {
	const bundleHash = Bun.hash(archiveBytes).toString(16);
	const outputDir = path.join(os.tmpdir(), "omp-collab-web", bundleHash);
	const markerPath = path.join(outputDir, "index.html");
	try {
		if ((await fs.stat(markerPath)).isFile()) return outputDir;
	} catch {}

	await fs.rm(outputDir, { recursive: true, force: true });
	await fs.mkdir(outputDir, { recursive: true });
	await extractArchive(archiveBytes, outputDir);
	return outputDir;
}
