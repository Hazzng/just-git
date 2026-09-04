import { describe, expect, test } from "bun:test";
import { findRepo } from "../../src/lib/repo";
import { resolveRenameLimit } from "../../src/lib/rename-detection";
import { TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

describe("rename detection", () => {
	test("resolves diff and merge rename-limit fallback chains", async () => {
		const bash = createTestBash({ env: TEST_ENV });
		await bash.exec("git init");
		const ctx = await findRepo(bash.fs, "/repo");
		if (!ctx) throw new Error("repository not found");

		expect(await resolveRenameLimit(ctx, "diff")).toBe(1000);
		expect(await resolveRenameLimit(ctx, "merge")).toBe(7000);

		await bash.exec("git config diff.renameLimit 12");
		expect(await resolveRenameLimit(ctx, "diff")).toBe(12);
		expect(await resolveRenameLimit(ctx, "merge")).toBe(12);

		await bash.exec("git config merge.renameLimit 34");
		expect(await resolveRenameLimit(ctx, "merge")).toBe(34);

		await bash.exec("git config merge.renameLimit 0");
		expect(await resolveRenameLimit(ctx, "merge")).toBe(0);
	});
});
