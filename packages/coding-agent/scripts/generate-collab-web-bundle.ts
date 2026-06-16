#!/usr/bin/env bun

/**
 * Build collab-web and embed its `dist/` as a base64 gzipped tar into
 * `src/collab/web-client.generated.txt`, so the compiled omp binary can serve
 * the collab-web app for `--web` without the source tree on disk.
 *
 * `--generate` builds + embeds; `--reset` restores the checked-in empty file so
 * the dev tree keeps building collab-web from source. Mirrors the stats
 * dashboard embed in `packages/stats/scripts/generate-client-bundle.ts`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const packageDir = path.join(import.meta.dir, "..");
const GENERATED_FILE = path.join(packageDir, "src", "collab", "web-client.generated.txt");
const COLLAB_WEB_DIR = path.join(packageDir, "..", "collab-web");
const DIST_DIR = path.join(COLLAB_WEB_DIR, "dist");

const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

async function buildArchiveBase64(dir: string): Promise<string> {
	const files = await collectFiles(dir);
	const entries: Record<string, Uint8Array> = {};
	for (const filePath of files) {
		const relativePath = path.relative(dir, filePath).split(path.sep).join("/");
		entries[relativePath] = await fs.readFile(filePath);
	}

	const tempArchivePath = path.join(
		os.tmpdir(),
		`omp-collab-web-${Bun.hash(Date.now().toString() + Math.random().toString(16)).toString(16)}.tar.gz`,
	);
	try {
		await Bun.Archive.write(tempArchivePath, entries, { compress: "gzip" });
		const archiveBytes = await Bun.file(tempArchivePath).bytes();
		return Buffer.from(archiveBytes).toString("base64");
	} finally {
		await fs.rm(tempArchivePath, { force: true });
	}
}

async function main(): Promise<void> {
	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(GENERATED_FILE, "");
		console.log(`Reset ${path.relative(packageDir, GENERATED_FILE)}`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		console.log(`Skipping collab-web bundle; pass ${GENERATE_FLAG} to build the embedded bundle`);
		return;
	}

	await $`bun --cwd=${COLLAB_WEB_DIR} run build`;
	const archiveBase64 = await buildArchiveBase64(DIST_DIR);
	await Bun.write(GENERATED_FILE, archiveBase64);
	console.log(`Generated ${path.relative(packageDir, GENERATED_FILE)} (${archiveBase64.length} base64 chars)`);
}

await main();
