import { describe, expect, test } from "bun:test";
import { findRepo } from "../../src/lib/repo";
import { resolveRenameLimit } from "../../src/lib/rename-detection";
import { TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

describe("rename detection", () => {
	test("resolves diff, merge, and status rename-limit fallback chains", async () => {
		const bash = createTestBash({ env: TEST_ENV });
		await bash.exec("git init");
		const ctx = await findRepo(bash.fs, "/repo");
		if (!ctx) throw new Error("repository not found");

		expect(await resolveRenameLimit(ctx, "diff")).toBe(1000);
		expect(await resolveRenameLimit(ctx, "merge")).toBe(7000);
		expect(await resolveRenameLimit(ctx, "status")).toBe(1000);

		await bash.exec("git config diff.renameLimit 12");
		expect(await resolveRenameLimit(ctx, "diff")).toBe(12);
		expect(await resolveRenameLimit(ctx, "merge")).toBe(12);
		expect(await resolveRenameLimit(ctx, "status")).toBe(12);

		await bash.exec("git config merge.renameLimit 34");
		expect(await resolveRenameLimit(ctx, "merge")).toBe(34);

		await bash.exec("git config status.renameLimit 56");
		expect(await resolveRenameLimit(ctx, "status")).toBe(56);

		await bash.exec("git config merge.renameLimit 0");
		expect(await resolveRenameLimit(ctx, "merge")).toBe(0);
	});

	test("accepts git integer suffixes and rejects malformed limits", async () => {
		const bash = createTestBash({ env: TEST_ENV });
		await bash.exec("git init");
		const ctx = await findRepo(bash.fs, "/repo");
		if (!ctx) throw new Error("repository not found");

		await bash.exec("git config diff.renameLimit 2k");
		expect(await resolveRenameLimit(ctx, "diff")).toBe(2048);

		await bash.exec("git config diff.renameLimit nope");
		expect(resolveRenameLimit(ctx, "diff")).rejects.toThrow(
			"fatal: bad numeric config value 'nope' for 'diff.renamelimit'",
		);
	});
});
