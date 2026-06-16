import { afterEach, describe, expect, it } from "bun:test";
import {
	type CollabWebLaunch,
	shouldUseGeneratedLocalTls,
	startCollabWebLaunch,
} from "@oh-my-pi/pi-coding-agent/collab/web-launch";

let launch: CollabWebLaunch | undefined;

afterEach(async () => {
	await launch?.stop();
	launch = undefined;
});

describe("startCollabWebLaunch", () => {
	it("serves the collab web app and short pair redirects", async () => {
		launch = await startCollabWebLaunch({ host: "127.0.0.1" });

		const health = await fetch(`${launch.webUrl}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok\n");

		const page = await fetch(launch.webUrl);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<div id="root"></div>');

		const published = launch.publishLink("localhost/r/test-room.abc123");
		expect(published.webLink).toBe(`${launch.webUrl}/#localhost/r/test-room.abc123`);
		expect(published.pairLink).toBe(`${launch.webUrl}/p/${published.pairCode}`);

		const pair = await fetch(published.pairLink, { redirect: "manual" });
		expect(pair.status).toBe(302);
		expect(pair.headers.get("location")).toBe("/#localhost/r/test-room.abc123");
	});

	it("selects generated HTTPS for LAN bind without manual certificate paths", () => {
		expect(shouldUseGeneratedLocalTls({ host: "0.0.0.0" })).toBe(true);
		expect(shouldUseGeneratedLocalTls({ host: "::" })).toBe(true);
		expect(shouldUseGeneratedLocalTls({ host: "127.0.0.1" })).toBe(false);
		expect(shouldUseGeneratedLocalTls({ host: "0.0.0.0", certPath: "cert.pem", keyPath: "key.pem" })).toBe(false);
	});
});
