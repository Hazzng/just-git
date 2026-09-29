import { describe, expect, test } from "bun:test";
import { QuietInjector } from "./quiet";

const ALWAYS = { rate: 1, misplacedRate: 0 };
const MISPLACED_ONLY = { rate: 0, misplacedRate: 1 };

function variants(command: string, config: { rate: number; misplacedRate: number }): Set<string> {
	const out = new Set<string>();
	for (let seed = 1; seed <= 40; seed++) out.add(new QuietInjector(seed, config).apply(command));
	return out;
}

describe("QuietInjector", () => {
	test("inserts either spelling right after the subcommand", () => {
		expect(variants('commit -m "a b"', ALWAYS)).toEqual(
			new Set(['commit -q -m "a b"', 'commit --quiet -m "a b"']),
		);
		expect(variants("rev-parse --verify main", ALWAYS)).toEqual(
			new Set(["rev-parse -q --verify main", "rev-parse --quiet --verify main"]),
		);
	});

	test("stash and worktree take the flag after their verb", () => {
		expect(variants("stash pop", ALWAYS)).toEqual(new Set(["stash pop -q", "stash pop --quiet"]));
		expect(variants("stash -u", ALWAYS)).toEqual(new Set(["stash -q -u", "stash --quiet -u"]));
		expect(variants("worktree add ../wt-x", ALWAYS)).toEqual(
			new Set(["worktree add -q ../wt-x", "worktree add --quiet ../wt-x"]),
		);
		expect(variants("stash list", ALWAYS)).toEqual(new Set(["stash list"]));
		expect(variants("worktree lock ../wt-x", ALWAYS)).toEqual(new Set(["worktree lock ../wt-x"]));
	});

	test("continuation modes and rejecting commands only get misplaced flags", () => {
		for (const command of ["rebase --continue", "merge --abort", "add .", "tag v1"]) {
			expect(variants(command, ALWAYS)).toEqual(new Set([command]));
		}
		expect(variants("rebase --continue", MISPLACED_ONLY)).toEqual(
			new Set(["rebase -q --continue", "rebase --quiet --continue"]),
		);
		expect(variants("stash pop", MISPLACED_ONLY)).toEqual(
			new Set(["stash -q pop", "stash --quiet pop"]),
		);
		expect(variants("cherry-pick main", MISPLACED_ONLY)).toEqual(new Set(["cherry-pick main"]));
		expect(variants("tag", MISPLACED_ONLY)).toEqual(new Set(["tag"]));
		expect(variants("tag v1", MISPLACED_ONLY)).toEqual(new Set(["tag -q v1", "tag --quiet v1"]));
	});

	test("zero rates never rewrite", () => {
		const injector = new QuietInjector(7, { rate: 0, misplacedRate: 0 });
		for (const command of ["commit -m x", "stash pop", "add .", "rebase --skip"]) {
			expect(injector.apply(command)).toBe(command);
		}
	});

	test("is deterministic per seed", () => {
		const commands = ["commit -m x", "checkout main", "stash pop", "add .", "merge --abort"];
		const config = { rate: 0.5, misplacedRate: 0.5 };
		const run = () => {
			const injector = new QuietInjector(42, config);
			return commands.map((c) => injector.apply(c));
		};
		expect(run()).toEqual(run());
	});
});
