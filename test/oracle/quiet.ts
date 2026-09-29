/**
 * `-q`/`--quiet` injection for oracle trace generation.
 *
 * Rewrites walker-produced git commands (without the leading `git`) so a
 * fraction of them carry `-q` or `--quiet`. The rewritten string is what gets
 * executed against real git and recorded, so replay needs no knowledge of it.
 *
 * Placement rules (verified against git 2.53):
 * - Most commands take the flag right after the subcommand, which also keeps
 *   the checker's two-token `baseCommand` keys intact.
 * - `stash` and `worktree` take it after their verb (`git stash pop -q`);
 *   `git stash -q pop` is a fatal error instead.
 * - `merge`/`rebase` continuation modes (`--continue`, `--abort`, ...) reject
 *   any extra argument with exit 129, so they only get the flag as a
 *   deliberately misplaced injection.
 */

import { SeededRNG } from "../random/rng";

export interface QuietConfig {
	/** Probability of adding the flag where real git accepts it. */
	rate: number;
	/** Probability of adding the flag where real git rejects it (usage/fatal paths). */
	misplacedRate?: number;
}

// cherry-pick/revert are deliberately absent: they hand unknown flags to
// revision parsing, so a misplaced `-q` fails as "bad revision" or usage
// depending on the commit argument, and `--quiet` is silently accepted.
const BOTH = ["-q", "--quiet"] as const;

const QUIET_COMMANDS: ReadonlySet<string> = new Set([
	"init",
	"clone",
	"fetch",
	"push",
	"pull",
	"commit",
	"merge",
	"rebase",
	"checkout",
	"switch",
	"restore",
	"reset",
	"rm",
	"clean",
	"branch",
	"gc",
	"repack",
	"show",
	"log",
	"rev-parse",
	"grep",
]);

const QUIET_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
	stash: new Set(["push", "pop", "apply", "drop"]),
	worktree: new Set(["add"]),
};

const CONTINUATION_MODES: ReadonlySet<string> = new Set([
	"--continue",
	"--abort",
	"--skip",
	"--quit",
]);

const REJECTING_COMMANDS: ReadonlySet<string> = new Set(["add", "status", "tag", "mv"]);

interface Placement {
	/** Token index the flag is inserted at. */
	at: number;
	spellings: readonly string[];
}

interface Placements {
	accepted: Placement | null;
	misplaced: Placement | null;
}

function placementsFor(tokens: readonly string[]): Placements {
	const [sub, verb] = tokens;
	if (sub === undefined) return { accepted: null, misplaced: null };

	if (QUIET_COMMANDS.has(sub)) {
		const isContinuation =
			(sub === "merge" || sub === "rebase") && tokens.some((t) => CONTINUATION_MODES.has(t));
		const placement = { at: 1, spellings: BOTH };
		return isContinuation
			? { accepted: null, misplaced: placement }
			: { accepted: placement, misplaced: null };
	}

	const verbs = QUIET_VERBS[sub];
	if (verbs) {
		if (sub === "stash" && (verb === undefined || verb.startsWith("-"))) {
			return { accepted: { at: 1, spellings: BOTH }, misplaced: null };
		}
		if (verb !== undefined && verbs.has(verb)) {
			return {
				accepted: { at: 2, spellings: BOTH },
				misplaced: sub === "stash" ? { at: 1, spellings: BOTH } : null,
			};
		}
		return { accepted: null, misplaced: null };
	}

	// Bare `tag` is the tag picker's listing query; failing it silently turns
	// tag actions into skips instead of exercising a usage error.
	if (REJECTING_COMMANDS.has(sub) && !(sub === "tag" && tokens.length === 1)) {
		return { accepted: null, misplaced: { at: 1, spellings: BOTH } };
	}
	return { accepted: null, misplaced: null };
}

/**
 * Stateful injector with its own RNG stream, so it never consumes the walker's
 * RNG. Picker lookups (`log --format=...`, `branch -r`) also pass through here
 * and may get an accepted flag, which leaves their output unchanged. A
 * misplaced flag on an action command changes its result, though, and the
 * walker's later choices follow from that.
 */
export class QuietInjector {
	private readonly rng: SeededRNG;

	constructor(
		seed: number,
		private readonly config: QuietConfig,
	) {
		this.rng = new SeededRNG(seed ^ 0x517e7);
	}

	/** Returns `command` with `-q`/`--quiet` possibly inserted. */
	apply(command: string): string {
		const tokens = command.split(" ");
		const { accepted, misplaced } = placementsFor(tokens);

		let placement: Placement | null = null;
		if (accepted && this.rng.bool(this.config.rate)) {
			placement = accepted;
		} else if (misplaced && this.rng.bool(this.config.misplacedRate ?? 0)) {
			placement = misplaced;
		}
		if (!placement) return command;

		const flag = this.rng.pick(placement.spellings);
		return [...tokens.slice(0, placement.at), flag, ...tokens.slice(placement.at)].join(" ");
	}
}
