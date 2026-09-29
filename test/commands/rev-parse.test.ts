import { describe, expect, test } from "bun:test";
import { BASIC_REPO, TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

async function setup() {
	const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');
	return bash;
}

const SILENT_FAILURE = { stdout: "", stderr: "", exitCode: 1 };

describe("git rev-parse", () => {
	describe("--verify", () => {
		test("fails with 'Needed a single revision' for an unknown rev", async () => {
			const bash = await setup();
			const result = await bash.exec("git rev-parse --verify nope");
			expect(result).toMatchObject({
				stdout: "",
				stderr: "fatal: Needed a single revision\n",
				exitCode: 128,
			});
		});

		test("fails with 'Needed a single revision' for a missing rev:path", async () => {
			const bash = await setup();
			const result = await bash.exec("git rev-parse --verify HEAD:nope");
			expect(result).toMatchObject({
				stdout: "",
				stderr: "fatal: Needed a single revision\n",
				exitCode: 128,
			});
		});
	});

	describe("--quiet", () => {
		test("-q --verify exits 1 silently for an unknown rev", async () => {
			const bash = await setup();
			expect(await bash.exec("git rev-parse -q --verify nope")).toMatchObject(SILENT_FAILURE);
			expect(await bash.exec("git rev-parse --verify --quiet HEAD~5")).toMatchObject(
				SILENT_FAILURE,
			);
		});

		test("-q --verify exits 1 silently for other verify failures", async () => {
			const bash = await setup();
			for (const cmd of [
				"git rev-parse -q --verify",
				"git rev-parse -q --verify HEAD HEAD",
				"git rev-parse -q --verify HEAD:nope",
				"git rev-parse -q --verify nope:README.md",
				"git rev-parse -q --verify --abbrev-ref nope",
				"git rev-parse -q --verify --symbolic-full-name nope",
			]) {
				expect(await bash.exec(cmd)).toMatchObject(SILENT_FAILURE);
			}
		});

		test("-q --verify still prints valid names", async () => {
			const bash = await setup();
			const head = (await bash.exec("git rev-parse HEAD")).stdout;
			expect(head).toMatch(/^[0-9a-f]{40}\n$/);

			expect(await bash.exec("git rev-parse -q --verify HEAD")).toMatchObject({
				stdout: head,
				stderr: "",
				exitCode: 0,
			});
			const short = await bash.exec("git rev-parse -q --verify --short HEAD");
			expect(short.stdout).toBe(`${head.slice(0, 7)}\n`);

			const tree = await bash.exec("git rev-parse --quiet --verify 'HEAD^{tree}'");
			expect(tree.stdout).toBe((await bash.exec("git rev-parse 'HEAD^{tree}'")).stdout);
			expect(tree.exitCode).toBe(0);

			const abbrev = await bash.exec("git rev-parse -q --verify --abbrev-ref HEAD");
			expect(abbrev.stdout).toBe("main\n");
		});

		test("without --verify, -q changes nothing", async () => {
			const bash = await setup();
			const quiet = await bash.exec("git rev-parse -q nope");
			const plain = await bash.exec("git rev-parse nope");
			expect(quiet).toMatchObject({ stderr: plain.stderr, exitCode: 128 });
			expect(quiet.stderr).toContain("fatal: ambiguous argument 'nope'");

			const missingPath = await bash.exec("git rev-parse -q HEAD:nope");
			expect(missingPath.stderr).toBe("fatal: path 'nope' does not exist in 'HEAD'\n");
			expect(missingPath.exitCode).toBe(128);

			const head = await bash.exec("git rev-parse -q HEAD");
			expect(head.stdout).toMatch(/^[0-9a-f]{40}\n$/);
		});
	});
});
