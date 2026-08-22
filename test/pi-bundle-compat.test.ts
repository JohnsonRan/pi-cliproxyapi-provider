import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const piPackageDir = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const piCliPath = join(piPackageDir, "dist", "bundle", "cli.js");
const piVersion = (JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8")) as { version: string }).version;

function runPiAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [piCliPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`Pi bundled CLI timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ status, stdout, stderr });
		});
	});
}

function completedSseResponse(text: string): string {
	const item = {
		type: "message",
		id: "msg_bundle",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const completed = {
		type: "response.completed",
		response: {
			id: "resp_bundle",
			status: "completed",
			output: [item],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	};
	return (
		`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n` +
		`data: ${JSON.stringify(completed)}\n\n`
	);
}

describe("Pi 0.84.3 bundled CLI compatibility", () => {
	it("runs stock Codex inference from a package copy without local node_modules", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-bundle-compat-"));
		const packageDir = join(root, "package");
		const agentDir = join(root, "agent");
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(agentDir, "tmp"), { recursive: true });
		cpSync(join(projectRoot, "extensions"), join(packageDir, "extensions"), { recursive: true });

		let modelRequestAuthorization: string | undefined;
		let inferenceHeaders: IncomingHttpHeaders | undefined;
		const server = createServer((request, response) => {
			if (request.url === "/v1/models?client_version=pi") {
				modelRequestAuthorization = request.headers.authorization;
				response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
				response.end(
					JSON.stringify({
						models: [
							{
								slug: "bundle-model",
								context_window: 128000,
								max_tokens: 16384,
								input_modalities: ["text"],
							},
						],
					}),
				);
				return;
			}
			if (request.url === "/backend-api/codex/responses") {
				inferenceHeaders = request.headers;
				request.resume();
				request.on("end", () => {
					response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
					response.end(completedSseResponse("bundle-ok"));
				});
				return;
			}
			response.writeHead(404, { Connection: "close" });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		try {
			const address = server.address() as AddressInfo;
			const baseUrl = `http://127.0.0.1:${address.port}`;
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl, apiKey: "bundle-real-key", transport: "sse" }),
				"utf8",
			);
			writeFileSync(
				join(agentDir, "tmp", "models-dev-cache.json"),
				JSON.stringify({ timestamp: Date.now(), providers: { test: { models: {} } } }),
				"utf8",
			);

			const env = { ...process.env };
			for (const name of Object.keys(env)) {
				if (name.startsWith("CLIPROXYAPI_")) delete env[name];
			}
			env.PI_CODING_AGENT_DIR = agentDir;
			env.PI_OFFLINE = "1";

			expect(piVersion).toBe("0.84.3");
			expect(existsSync(piCliPath)).toBe(true);
			expect(existsSync(join(packageDir, "node_modules"))).toBe(false);
			const result = await runPiAsync(
				[
					"--no-extensions",
					"-e",
					join(packageDir, "extensions", "index.ts"),
					"--provider",
					"cliproxyapi",
					"--model",
					"bundle-model",
					"--no-tools",
					"--no-session",
					"-p",
					"hello",
				],
				env,
				30_000,
			);
			const output = `${result.stdout}\n${result.stderr}`;

			expect(result.status, output).toBe(0);
			expect(output).not.toContain("failed to load Codex protocol");
			expect(output).not.toContain("Cannot resolve openai-codex-responses.js");
			expect(output).toContain("bundle-ok");
			expect(modelRequestAuthorization).toBe("Bearer bundle-real-key");
			expect(inferenceHeaders?.["x-api-key"]).toBe("bundle-real-key");
			expect(inferenceHeaders?.authorization).toMatch(/^Bearer eyJ/);
			expect(inferenceHeaders?.authorization).not.toContain("bundle-real-key");
			expect(inferenceHeaders?.["chatgpt-account-id"]).toMatch(/^cpa_[0-9a-f]{64}$/);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
