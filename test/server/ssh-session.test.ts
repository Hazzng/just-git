import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Server, type ServerChannel } from "ssh2";
import { writeObject } from "../../src/lib/object-db.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { parseGitSshCommand } from "../../src/server/ssh-session.ts";
import type { GitServer, SshChannel } from "../../src/server/types.ts";
import { isolatedGitEnv } from "../real-git.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

// ── ssh2 adapter helper ─────────────────────────────────────────────

function wrapSsh2Channel(stream: ServerChannel): SshChannel {
	return {
		readable: new ReadableStream({
			start(controller) {
				stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
				stream.on("end", () => controller.close());
				stream.on("error", (err: Error) => controller.error(err));
			},
		}),
		writable: new WritableStream({
			write(chunk) {
				return new Promise<void>((resolve, reject) => {
					stream.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve()));
				});
			},
		}),
		writeStderr(data: Uint8Array) {
			stream.stderr.write(Buffer.from(data));
		},
	};
}

// ── parseGitSshCommand unit tests ───────────────────────────────────

describe("parseGitSshCommand", () => {
	test("hyphenated upload-pack with single-quoted path", () => {
		const result = parseGitSshCommand("git-upload-pack '/my-repo.git'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "my-repo.git" });
	});

	test("hyphenated receive-pack with single-quoted path", () => {
		const result = parseGitSshCommand("git-receive-pack '/repos/test'");
		expect(result).toEqual({ service: "git-receive-pack", repoPath: "repos/test" });
	});

	test("two-word form", () => {
		const result = parseGitSshCommand("git upload-pack '/repo'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("unquoted path", () => {
		const result = parseGitSshCommand("git-upload-pack /repo");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("path without leading slash", () => {
		const result = parseGitSshCommand("git-upload-pack 'repo'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("rejects unknown commands", () => {
		expect(parseGitSshCommand("ls -la")).toBeNull();
		expect(parseGitSshCommand("git status")).toBeNull();
		expect(parseGitSshCommand("")).toBeNull();
	});
});

// ── SSH server integration tests ────────────────────────────────────

const HOST_KEY_PATH = "/tmp/just-git-test-host-key";
const hasHostKey = existsSync(HOST_KEY_PATH);

describe("SSH session handler", () => {
	let sshServer: Server;
	let sshPort: number;
	let driver: MemoryStorage;
	let server: GitServer;

	beforeAll(async () => {
		driver = new MemoryStorage();
		server = createServer({ storage: driver });
		const repo = await server.createRepo("test-repo");

		const readmeBlob = await writeBlob(repo, "# SSH Test");
		const indexBlob = await writeBlob(repo, "export const x = 1;");
		const srcTree = await writeTree(repo, [{ name: "index.ts", hash: indexBlob }]);
		const rootTree = await writeTree(repo, [
			{ name: "README.md", hash: readmeBlob },
			{ name: "src", hash: srcTree, mode: "40000" },
		]);
		const commitHash = await createCommit(repo, {
			tree: rootTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "initial\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/v1.0", { type: "direct", hash: commitHash });

		if (!hasHostKey) return;

		const hostKey = readFileSync(HOST_KEY_PATH);

		sshPort = await new Promise<number>((resolve, reject) => {
			sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
				client.on("authentication", (ctx) => ctx.accept());
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (accept, _reject, info) => {
						const stream = accept();
						const channel = wrapSsh2Channel(stream);
						server
							.handleSession(info.command, channel, {
								username: "test-user",
							})
							.then((code) => {
								stream.exit(code);
								stream.end();
							});
					});
				});
			});

			sshServer.listen(0, "127.0.0.1", function (this: Server) {
				const addr = this.address();
				if (typeof addr === "object" && addr) {
					resolve(addr.port);
				} else {
					reject(new Error("Failed to get SSH server port"));
				}
			});
		});
	});

	afterAll(() => {
		sshServer?.close();
	});

	test("handleSession processes upload-pack", async () => {
		const testServer = createServer({ storage: driver });

		const repo = (await testServer.repo("test-repo"))!;
		const { refs: allRefs } = await import("../../src/server/operations.ts").then((m) =>
			m.collectRefs(repo),
		);
		const headRef = allRefs.find((r) => r.name === "HEAD");
		expect(headRef).toBeTruthy();

		const wantLine = `want ${headRef!.hash}\n`;
		const wantPkt = encodePktLine(wantLine);
		const flushPkt = new Uint8Array([0x30, 0x30, 0x30, 0x30]);
		const donePkt = encodePktLine("done\n");

		const requestBytes = concatBytes(wantPkt, flushPkt, donePkt);

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(controller) {
					controller.enqueue(requestBytes);
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(0);
		expect(responseChunks.length).toBeGreaterThan(0);

		const totalResponse = concatBytes(...responseChunks);
		const text = new TextDecoder().decode(totalResponse);
		expect(text).toContain("HEAD");
	});

	test("handleSession rejects unknown repo", async () => {
		const testServer = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/no-such-repo'", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("does not appear to be a git repository");
	});

	test("handleSession rejects unknown command", async () => {
		const testServer = createServer({
			storage: driver,
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("ls -la", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("unrecognized command");
	});

	test("handleSession rejects when advertiseRefs returns rejection", async () => {
		const testServer = createServer({
			storage: driver,
			hooks: {
				advertiseRefs: async () => {
					return { reject: true, message: "no access" };
				},
			},
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("no access");
	});

	test("protocol v2 fetch rejects hidden refs", async () => {
		const testServer = createServer({
			storage: driver,
			hooks: {
				advertiseRefs: async ({ refs, service }) =>
					service === "git-upload-pack"
						? refs.filter((ref) => ref.name !== "refs/heads/internal")
						: refs,
			},
			onError: false,
		});

		const repo = (await testServer.repo("test-repo"))!;
		const hiddenBlob = await writeBlob(repo, "internal");
		const hiddenTree = await writeTree(repo, [{ name: "internal.txt", hash: hiddenBlob }]);
		const hiddenHash = await createCommit(repo, {
			tree: hiddenTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "internal\n",
		});
		await repo.refStore.writeRef("refs/heads/internal", { type: "direct", hash: hiddenHash });

		const delimPkt = new Uint8Array([0x30, 0x30, 0x30, 0x31]);
		const flushPkt = new Uint8Array([0x30, 0x30, 0x30, 0x30]);
		const fetchRequest = concatBytes(
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=test\n"),
			delimPkt,
			encodePktLine("want-ref refs/heads/internal\n"),
			encodePktLine("done\n"),
			flushPkt,
		);

		let stderrOutput = "";
		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(controller) {
					controller.enqueue(fetchRequest);
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession(
			"git-upload-pack --protocol=version=2 '/test-repo'",
			channel,
		);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("forbidden want-ref");
		expect(new TextDecoder().decode(concatBytes(...responseChunks))).toContain("version 2");
	});

	test("handleSession handles empty upload-pack (ls-remote)", async () => {
		const testServer = createServer({ storage: driver });

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(0);
		const text = new TextDecoder().decode(concatBytes(...responseChunks));
		expect(text).toContain("HEAD");
	});

	test.skipIf(!hasHostKey)("real git clone over SSH", async () => {
		const workDir = await createSshTestDir();
		const env = sshTestEnv(sshPort, workDir);

		const clone = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "cloned"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const cloneResult = await collectProc(clone);
		expect(cloneResult.exitCode).toBe(0);

		const { readFileSync: readFs } = await import("node:fs");
		const { join } = await import("node:path");
		expect(readFs(join(workDir, "cloned", "README.md"), "utf8")).toBe("# SSH Test");
		expect(readFs(join(workDir, "cloned", "src", "index.ts"), "utf8")).toBe("export const x = 1;");

		await cleanupDir(workDir);
	});

	test.skipIf(!hasHostKey)("real git clone + push over SSH", async () => {
		const workDir = await createSshTestDir();
		const env = sshTestEnv(sshPort, workDir);
		const { join } = await import("node:path");
		const { readFileSync: readFs, writeFileSync: writeFs } = await import("node:fs");

		const clone = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "work"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(clone)).exitCode).toBe(0);

		const repoDir = join(workDir, "work");

		writeFs(join(repoDir, "new-file.txt"), "pushed via SSH");
		const add = Bun.spawn(["git", "add", "."], {
			cwd: repoDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(add)).exitCode).toBe(0);

		const commitEnv = {
			...env,
			GIT_AUTHOR_NAME: "SSH Test",
			GIT_AUTHOR_EMAIL: "ssh@test.com",
			GIT_COMMITTER_NAME: "SSH Test",
			GIT_COMMITTER_EMAIL: "ssh@test.com",
		};
		const commit = Bun.spawn(["git", "commit", "-m", "push test"], {
			cwd: repoDir,
			env: commitEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(commit)).exitCode).toBe(0);

		const push = Bun.spawn(["git", "push", "origin", "main"], {
			cwd: repoDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const pushResult = await collectProc(push);
		expect(pushResult.exitCode).toBe(0);

		const repo = await server.requireRepo("test-repo");
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		expect(mainRef).toBeTruthy();

		const clone2 = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "verify"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(clone2)).exitCode).toBe(0);
		expect(readFs(join(workDir, "verify", "new-file.txt"), "utf8")).toBe("pushed via SSH");

		await cleanupDir(workDir);
	});

	test.skipIf(!hasHostKey)(
		"real git clone over SSH of a pack larger than the SSH window",
		async () => {
			// ssh2's initial channel window is 2 MiB; random bytes don't compress or deltify.
			const big = new Uint8Array(6 * 1024 * 1024);
			for (let i = 0; i < big.byteLength; i += 65536) {
				crypto.getRandomValues(big.subarray(i, i + 65536));
			}
			await createLinearRepo("big-repo", 1, big);

			const workDir = await createSshTestDir();
			const clone = await runGit(
				["clone", "ssh://test@127.0.0.1/big-repo", "cloned"],
				workDir,
				sshTestEnv(sshPort, workDir),
			);
			expect(clone.exitCode).toBe(0);
			expect(readFileSync(`${workDir}/cloned/file.bin`).byteLength).toBe(big.byteLength);

			await cleanupDir(workDir);
		},
		60_000,
	);

	test.skipIf(!hasHostKey)(
		"real git shallow clone over SSH",
		async () => {
			const tip = await createLinearRepo("shallow-repo", 5);

			const workDir = await createSshTestDir();
			const env = sshTestEnv(sshPort, workDir);
			const clone = await runGit(
				["clone", "--depth", "2", "ssh://test@127.0.0.1/shallow-repo", "cloned"],
				workDir,
				env,
			);
			expect(clone.exitCode).toBe(0);

			const log = await runGit(["rev-list", "HEAD"], `${workDir}/cloned`, env);
			expect(log.stdout.trim().split("\n")).toHaveLength(2);
			expect(log.stdout.startsWith(tip)).toBe(true);

			const deepen = await runGit(["fetch", "--depth", "4"], `${workDir}/cloned`, env);
			expect(deepen.exitCode).toBe(0);
			const deeper = await runGit(["rev-list", "HEAD"], `${workDir}/cloned`, env);
			expect(deeper.stdout.trim().split("\n")).toHaveLength(4);

			await cleanupDir(workDir);
		},
		60_000,
	);

	test.skipIf(!hasHostKey)(
		"real git fetch over SSH negotiates across multiple have batches",
		async () => {
			await createLinearRepo("negotiate-repo", 3);

			const workDir = await createSshTestDir();
			const env = {
				...sshTestEnv(sshPort, workDir),
				GIT_AUTHOR_NAME: "SSH Test",
				GIT_AUTHOR_EMAIL: "ssh@test.com",
				GIT_COMMITTER_NAME: "SSH Test",
				GIT_COMMITTER_EMAIL: "ssh@test.com",
			};
			const repoDir = `${workDir}/work`;
			expect(
				(await runGit(["clone", "ssh://test@127.0.0.1/negotiate-repo", "work"], workDir, env))
					.exitCode,
			).toBe(0);

			// git sends haves in batches of 16 and waits for a reply after the second flush.
			for (let i = 0; i < 40; i++) {
				await runGit(["commit", "--allow-empty", "-q", "-m", `local ${i}`], repoDir, env);
			}
			const remoteTip = await createLinearRepo("negotiate-repo", 1);

			const fetch = await runGit(["fetch", "origin"], repoDir, env);
			expect(fetch.exitCode).toBe(0);
			const fetched = await runGit(["rev-parse", "origin/main"], repoDir, env);
			expect(fetched.stdout.trim()).toBe(remoteTip);

			await cleanupDir(workDir);
		},
		60_000,
	);

	/** Append `count` commits to `refs/heads/main` of `name` (creating it), returning the new tip. */
	async function createLinearRepo(name: string, count: number, content?: Uint8Array) {
		const repo = (await server.repo(name)) ?? (await server.createRepo(name));
		const head = await repo.refStore.readRef("refs/heads/main");
		let tip = head?.type === "direct" ? head.hash : "";
		for (let i = 0; i < count; i++) {
			const blob = content
				? await writeObject(repo, "blob", content)
				: await writeBlob(repo, `${name} commit ${i} ${tip}`);
			const tree = await writeTree(repo, [{ name: content ? "file.bin" : "file.txt", hash: blob }]);
			tip = await createCommit(repo, {
				tree,
				parents: tip ? [tip] : [],
				author: TEST_IDENTITY,
				committer: TEST_IDENTITY,
				message: `${name} ${i}\n`,
			});
		}
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: tip });
		return tip;
	}
});

async function runGit(args: string[], cwd: string, env: Record<string, string>) {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	return collectProc(proc);
}

// ── Helpers ─────────────────────────────────────────────────────────

function encodePktLine(data: string): Uint8Array {
	const payload = new TextEncoder().encode(data);
	const totalLen = 4 + payload.byteLength;
	const hex = totalLen.toString(16).padStart(4, "0");
	const result = new Uint8Array(totalLen);
	result[0] = hex.charCodeAt(0);
	result[1] = hex.charCodeAt(1);
	result[2] = hex.charCodeAt(2);
	result[3] = hex.charCodeAt(3);
	result.set(payload, 4);
	return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const a of arrays) len += a.byteLength;
	const result = new Uint8Array(len);
	let off = 0;
	for (const a of arrays) {
		result.set(a, off);
		off += a.byteLength;
	}
	return result;
}

async function collectProc(proc: ReturnType<typeof Bun.spawn>) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function createSshTestDir() {
	const { mkdtemp } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	return mkdtemp(join(tmpdir(), "just-git-ssh-test-"));
}

async function cleanupDir(dir: string) {
	const { rm } = await import("node:fs/promises");
	await rm(dir, { recursive: true, force: true });
}

function sshTestEnv(port: number, home: string): Record<string, string> {
	return isolatedGitEnv(home, {
		GIT_PROTOCOL_VERSION: "1",
		GIT_SSH_COMMAND: `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${port}`,
	});
}
