import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --web flags", () => {
	it("parses local collab web launch options", () => {
		const result = parseArgs([
			"--web",
			"--web-host",
			"0.0.0.0",
			"--web-port=7443",
			"--web-url",
			"https://omp.test",
			"--web-cert",
			"cert.pem",
			"--web-key",
			"key.pem",
		]);

		expect(result.web).toBe(true);
		expect(result.webHost).toBe("0.0.0.0");
		expect(result.webPort).toBe(7443);
		expect(result.webUrl).toBe("https://omp.test");
		expect(result.webCert).toBe("cert.pem");
		expect(result.webKey).toBe("key.pem");
		expect(result.unrecognizedFlags).toEqual([]);
	});

	it("keeps --web boolean from consuming the next flag", () => {
		const result = parseArgs(["--web", "--model", "opus"]);

		expect(result.web).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});
});
