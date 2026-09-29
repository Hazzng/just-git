import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "../fixtures";
import { createTestBash, pathExists, readFile, setupClonePair } from "../util";

describe("git push", () => {
	test("pushes current branch to remote", async () => {
		const bash = await setupClonePair();

		// Make a commit in the local repo
		await bash.exec(
			"cd /local && echo 'v2' > README.md && git add . && git commit -m 'local update'",
		);

		const result = await bash.exec("git push", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("To /remote");
	});

	test("updates remote ref after push", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

		const localLog = await bash.exec("cd /local && git log --oneline");
		await bash.exec("git push", { cwd: "/local" });
		const remoteLog = await bash.exec("cd /remote && git log --oneline");

		// Remote should have the same commits
		expect(remoteLog.stdout.trim().split("\n").length).toBe(
			localLog.stdout.trim().split("\n").length,
		);
	});

	test("pushes new branch with explicit refspec", async () => {
		const bash = await setupClonePair();

		await bash.exec(
			"cd /local && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feature",
		);

		const result = await bash.exec("git push origin feature:refs/heads/feature", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new branch]");

		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
	});

	test("pushes all branches with --all", async () => {
		const bash = await setupClonePair();

		await bash.exec(
			"cd /local && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feature",
		);
		await bash.exec("cd /local && git checkout main");

		const result = await bash.exec("git push --all", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
	});

	test("sets upstream with -u", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

		const result = await bash.exec("git push -u origin", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("set up to track");

		// Verify config was written
		const config = await readFile(bash.fs, "/local/.git/config");
		expect(config).toContain('branch "main"');
		expect(config).toContain("remote = origin");
	});

	test("reports error for detached HEAD without refspec", async () => {
		const bash = await setupClonePair();

		// Use tag to get to detached HEAD (resolveRevision supports tags)
		await bash.exec("cd /local && git tag v0 && git checkout v0");

		const result = await bash.exec("git push", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("not currently on a branch");
	});

	test("fails for unknown remote", async () => {
		const bash = await setupClonePair();
		const result = await bash.exec("git push nonexistent", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not appear to be");
	});

	test("pushes tags with --tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");

		const result = await bash.exec("git push --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);
	});

	test("--tags with explicit refspec pushes both branch and tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");
		await bash.exec("cd /local && git tag v2.0");

		const localHead = await bash.exec("cd /local && git rev-parse HEAD");

		const result = await bash.exec("git push origin main --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		// Branch was pushed
		const remoteMain = await readFile(bash.fs, "/remote/.git/refs/heads/main");
		expect(remoteMain?.trim()).toBe(localHead.stdout.trim());

		// Tags were pushed
		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);
		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v2.0")).toBe(true);

		// Output mentions both
		expect(result.stderr).toMatch(/main\s+-> main/);
		expect(result.stderr).toContain("[new tag]");
	});

	test("--tags alone does not push current branch via push.default", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

		const localHead = await bash.exec("cd /local && git rev-parse HEAD");
		const remoteBefore = await readFile(bash.fs, "/remote/.git/refs/heads/main");

		const result = await bash.exec("git push origin --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		// Tag was pushed
		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);

		// Branch was NOT pushed — remote main should still be at original commit
		const remoteAfter = await readFile(bash.fs, "/remote/.git/refs/heads/main");
		expect(remoteAfter?.trim()).toBe(remoteBefore?.trim());
		expect(remoteAfter?.trim()).not.toBe(localHead.stdout.trim());
	});

	test("--tags with --all errors", async () => {
		const bash = await setupClonePair();
		const result = await bash.exec("git push --all --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("cannot be used together");
	});

	test("--tags with --delete errors", async () => {
		const bash = await setupClonePair();
		const result = await bash.exec("git push --delete --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("cannot be used together");
	});

	test("--tags skips tags already on remote", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("git push origin --tags", { cwd: "/local" });

		// Create another tag
		await bash.exec("cd /local && git tag v2.0");

		const result = await bash.exec("git push origin --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).toContain("v2.0");
		// v1.0 should not appear in output since it's already up-to-date
		expect(result.stderr).not.toContain("v1.0");
	});

	test("--tags output shows [new tag] not [new branch]", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");

		const result = await bash.exec("git push origin --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).not.toContain("[new branch]");
	});

	test("--tags reports already exists for conflicting remote tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("cd /remote && echo remote > remote.txt && git add . && git commit -m remote");
		await bash.exec("cd /remote && git tag -f v1.0 HEAD");

		const result = await bash.exec("git push origin --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("(already exists)");
		expect(result.stderr).toContain("tag already exists in the remote");
	});

	test("--tags rejects updating an existing remote tag even when fast-forward", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && git tag beta-61.3");
		await bash.exec("git fetch --tags", { cwd: "/local" });
		await bash.exec("cd /local && echo local > local.txt && git add . && git commit -m local");
		await bash.exec("cd /local && git tag -f beta-61.3 HEAD");

		const result = await bash.exec("git push origin --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("! [rejected]");
		expect(result.stderr).toContain("beta-61.3 -> beta-61.3 (already exists)");
		expect(result.stderr).toContain("tag already exists in the remote");
		expect(result.stderr).not.toContain("beta-61.3 -> beta-61.3\n");
	});

	test("bare tag name pushes to refs/tags/ on remote", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");

		const result = await bash.exec("git push origin v1.0", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).not.toContain("[new branch]");

		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);
		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/v1.0")).toBe(false);
	});

	test("bare tag name pushes annotated tag object hash", async () => {
		const bash = await setupClonePair();

		await bash.exec('cd /local && git tag -a v2.0 -m "release 2"');

		const result = await bash.exec("git push origin v2.0", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");

		const localTagHash = await readFile(bash.fs, "/local/.git/refs/tags/v2.0");
		const remoteTagHash = await readFile(bash.fs, "/remote/.git/refs/tags/v2.0");
		expect(remoteTagHash?.trim()).toBe(localTagHash?.trim());
	});

	test("--delete resolves bare tag name against remote refs", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("git push --tags", { cwd: "/local" });
		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);

		const result = await bash.exec("git push --delete origin v1.0", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[deleted]");

		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(false);
	});

	test("bare branch name still pushes to refs/heads/", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git checkout -b feature");
		await bash.exec("cd /local && echo feat > feat.txt && git add . && git commit -m feature");

		const result = await bash.exec("git push origin feature", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new branch]");

		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/feature")).toBe(false);
	});

	test("up-to-date push reports everything up-to-date", async () => {
		const bash = await setupClonePair();

		// Push without changes — remote already has everything
		const result = await bash.exec("git push", { cwd: "/local" });
		// Should succeed (nothing to push, remote already matches)
		expect(result.exitCode).toBe(0);
	});

	describe("push.default", () => {
		test("simple (default) pushes tracked branch with matching name", async () => {
			const bash = await setupClonePair();
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("To /remote");
		});

		test("simple refuses when upstream name differs from local branch", async () => {
			const bash = await setupClonePair();

			// Create a local branch that tracks a differently-named remote branch
			await bash.exec("cd /local && git checkout -b my-feature");
			await bash.exec("cd /local && echo feat > feat.txt && git add . && git commit -m feat");
			// Set tracking to origin/main (name mismatch: my-feature != main)
			await bash.exec(
				"cd /local && git config set branch.my-feature.remote origin && git config set branch.my-feature.merge refs/heads/main",
			);

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not match");
			expect(result.stderr).toContain("the name of your current branch");
			expect(result.stderr).toContain("To choose either option permanently");
		});

		test("configured push.default=simple omits push.default advice", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git checkout -b my-feature");
			await bash.exec("cd /local && echo feat > feat.txt && git add . && git commit -m feat");
			await bash.exec("cd /local && git config set push.default simple");
			await bash.exec(
				"cd /local && git config set branch.my-feature.remote origin && git config set branch.my-feature.merge refs/heads/main",
			);

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not match");
			expect(result.stderr).not.toContain("To choose either option permanently");
		});

		test("simple refuses push when no upstream configured", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git checkout -b new-branch");
			await bash.exec("cd /local && echo new > new.txt && git add . && git commit -m new");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("has no upstream branch");
			expect(result.stderr).toContain("--set-upstream");
		});

		test("simple falls back to current when pushing to a different remote", async () => {
			const bash = await setupClonePair();

			// Set up a second remote
			await bash.exec("cd /local && git init --bare /remote2");
			await bash.exec("cd /local && git remote add other /remote2");

			// Track origin/main, but push to 'other'
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push other", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("[new branch]");
		});

		test("push.default=current pushes to same-named remote branch", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default current");
			await bash.exec("cd /local && git checkout -b my-feature");
			await bash.exec("cd /local && echo feat > feat.txt && git add . && git commit -m feat");
			// Set mismatched tracking — current mode ignores it
			await bash.exec(
				"cd /local && git config set branch.my-feature.remote origin && git config set branch.my-feature.merge refs/heads/main",
			);

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("[new branch]");
			expect(result.stderr).toContain("my-feature");
		});

		test("push.default=upstream pushes to tracked upstream branch", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default upstream");
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("To /remote");
		});

		test("push.default=upstream errors when no upstream configured", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default upstream");
			await bash.exec("cd /local && git checkout -b no-upstream");
			await bash.exec("cd /local && echo x > x.txt && git add . && git commit -m x");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("has no upstream branch");
			expect(result.stderr).toContain("--set-upstream");
		});

		test("push.default=nothing errors without explicit refspec", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default nothing");
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain('push.default is "nothing"');
		});

		test("push.default=nothing takes precedence over detached HEAD", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default nothing");
			await bash.exec("cd /local && git tag v0 && git checkout v0");

			const result = await bash.exec("git push", { cwd: "/local" });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toBe(
				'fatal: You didn\'t specify any refspecs to push, and push.default is "nothing".\n',
			);
		});

		test("push.default=nothing still allows explicit refspec", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && git config set push.default nothing");
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push origin main:refs/heads/main", {
				cwd: "/local",
			});
			expect(result.exitCode).toBe(0);
		});
	});

	describe("SSH remote", () => {
		test("gives clear error for git@ SSH URL", async () => {
			const bash = createTestBash({ env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("echo hi > file.txt && git add . && git commit -m init");
			await bash.exec("git remote add origin git@github.com:user/repo.git");

			const result = await bash.exec("git push origin main");
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("SSH transport is not supported");
			expect(result.stderr).toContain("HTTPS");
		});

		test("gives clear error for ssh:// URL", async () => {
			const bash = createTestBash({ env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("echo hi > file.txt && git add . && git commit -m init");
			await bash.exec("git remote add origin ssh://git@github.com/user/repo.git");

			const result = await bash.exec("git push origin main");
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("SSH transport is not supported");
		});
	});

	describe("--quiet", () => {
		const NON_FF_HINT =
			"hint: Updates were rejected because the tip of your current branch is behind\n" +
			"hint: its remote counterpart. If you want to integrate the remote changes,\n" +
			"hint: use 'git pull' before pushing again.\n" +
			"hint: See the 'Note about fast-forwards' in 'git push --help' for details.\n";

		test("-q is silent on success and still pushes", async () => {
			const bash = await setupClonePair();
			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git push -q", { cwd: "/local" });
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect(await readFile(bash.fs, "/remote/.git/refs/heads/main")).toBe(
				await readFile(bash.fs, "/local/.git/refs/heads/main"),
			);
		});

		test("--quiet suppresses 'Everything up-to-date'", async () => {
			const bash = await setupClonePair();
			const result = await bash.exec("git push --quiet", { cwd: "/local" });
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("-q -u suppresses the tracking message but writes config", async () => {
			const bash = await setupClonePair();
			await bash.exec(
				"cd /local && git checkout -b feature && echo f > f.txt && git add . && git commit -m f",
			);

			const result = await bash.exec("git push -q -u origin feature", { cwd: "/local" });
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
			const config = await readFile(bash.fs, "/local/.git/config");
			expect(config).toContain('[branch "feature"]');

			const again = await bash.exec("git push -q -u origin feature", { cwd: "/local" });
			expect(again).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("-q is silent for --tags and --delete", async () => {
			const bash = await setupClonePair();
			await bash.exec("cd /local && git tag v1.0");

			const pushTags = await bash.exec("git push -q --tags", { cwd: "/local" });
			expect(pushTags).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);

			const del = await bash.exec("git push -q --delete origin v1.0", { cwd: "/local" });
			expect(del).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(false);
		});

		test("-q still prints the full ref table, error, and hints on rejection", async () => {
			const bash = await setupClonePair();
			await bash.exec("cd /remote && echo remote > r.txt && git add . && git commit -m remote");
			await bash.exec("cd /local && echo local > l.txt && git add . && git commit -m local");
			await bash.exec("cd /local && git branch side && git fetch -q");

			const result = await bash.exec("git push -q origin main side", { cwd: "/local" });
			expect(result).toMatchObject({
				stdout: "",
				stderr:
					"To /remote\n" +
					" * [new branch]      side -> side\n" +
					" ! [rejected]        main -> main (non-fast-forward)\n" +
					"error: failed to push some refs to '/remote'\n" +
					NON_FF_HINT,
				exitCode: 1,
			});
			expect(await pathExists(bash.fs, "/remote/.git/refs/heads/side")).toBe(true);
		});

		test("-q still reports errors", async () => {
			const bash = await setupClonePair();
			const missingSrc = await bash.exec("git push -q origin nosuch", { cwd: "/local" });
			expect(missingSrc).toMatchObject({
				stdout: "",
				stderr:
					"error: src refspec nosuch does not match any\n" +
					"error: failed to push some refs to '/remote'\n",
				exitCode: 1,
			});

			const missingDelete = await bash.exec("git push -q --delete origin nosuch", {
				cwd: "/local",
			});
			expect(missingDelete).toMatchObject({
				stdout: "",
				stderr:
					"error: unable to delete 'nosuch': remote ref does not exist\n" +
					"error: failed to push some refs to '/remote'\n",
				exitCode: 1,
			});
		});

		test("--no-quiet after -q restores output", async () => {
			const bash = await setupClonePair();
			const result = await bash.exec("git push -q --no-quiet", { cwd: "/local" });
			expect(result).toMatchObject({
				stdout: "",
				stderr: "Everything up-to-date\n",
				exitCode: 0,
			});
		});
	});
});
