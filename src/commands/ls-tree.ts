import type { GitExtensions } from "../git.ts";
import {
	DEFAULT_ABBREV,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	uniqueAbbrev,
} from "../lib/command-utils.ts";
import { readObject } from "../lib/object-db.ts";
import { parseCommit } from "../lib/objects/commit.ts";
import { parseTag } from "../lib/objects/tag.ts";
import { parseTree } from "../lib/objects/tree.ts";
import { join, relative } from "../lib/path.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { FileMode, type GitRepo, type ObjectId, type TreeEntry } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

interface WalkOptions {
	recursive: boolean;
	showTrees: boolean;
	treesOnly: boolean;
	/**
	 * Literal repo-relative paths, never globs. A trailing `/` selects a
	 * directory's contents rather than the directory entry itself, and `""`
	 * selects everything.
	 */
	specs: string[];
}

interface ListedEntry extends TreeEntry {
	path: string;
}

export function registerLsTreeCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("ls-tree", {
		description: "List the contents of a tree object",
		args: [
			a.string().name("tree-ish").describe("Tree, commit or tag to list"),
			a.string().name("path").variadic().optional(),
		],
		options: {
			treesOnly: f().alias("d").describe("Only show trees"),
			recursive: f().alias("r").describe("Recurse into subtrees"),
			showTrees: f().alias("t").describe("Show trees when recursing"),
			nulTerminate: f().alias("z").describe("Terminate entries with NUL byte"),
			nameOnly: f().describe("List only filenames"),
			nameStatus: f().describe("List only filenames"),
			fullTree: f().describe("List entire tree; not just current directory"),
			abbrev: o
				.number()
				.impliedValue(String(DEFAULT_ABBREV))
				.describe("Use <n> digits to display object names"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const resolved = await resolveRevision(gitCtx, args["tree-ish"]);
			if (!resolved) return fatal(`Not a valid object name ${args["tree-ish"]}`);
			const treeHash = await peelToTree(gitCtx, resolved);
			if (!treeHash) return fatal("not a tree object");

			const prefix = args.fullTree ? "" : getCwdPrefix(gitCtx, ctx.cwd);
			const rawPaths = [...(args.path ?? []), ...meta.passthrough];
			const specs: string[] = [];
			for (const raw of rawPaths) {
				const spec = resolveSpec(raw, prefix, gitCtx.workTree);
				if (spec === null) {
					return fatal(
						`${raw}: '${raw}' is outside repository at '${gitCtx.workTree ?? gitCtx.gitDir}'`,
					);
				}
				specs.push(spec);
			}
			if (specs.length === 0 && prefix !== "") specs.push(`${prefix}/`);

			const entries: ListedEntry[] = [];
			await collect(gitCtx, treeHash, "", entries, {
				recursive: args.recursive,
				showTrees: args.showTrees || (args.recursive && args.treesOnly),
				treesOnly: args.treesOnly,
				specs,
			});

			const nameOnly = args.nameOnly || args.nameStatus;
			const terminator = args.nulTerminate ? "\0" : "\n";
			let stdout = "";
			for (const entry of entries) {
				const displayPath = prefix ? relative(prefix, entry.path) || "./" : entry.path;
				const name = args.nulTerminate ? displayPath : quotePath(displayPath);
				if (nameOnly) {
					stdout += name + terminator;
					continue;
				}
				const oid = args.abbrev ? await uniqueAbbrev(gitCtx, entry.hash, args.abbrev) : entry.hash;
				stdout += `${entry.mode} ${objectType(entry.mode)} ${oid}\t${name}${terminator}`;
			}
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

async function peelToTree(ctx: GitRepo, hash: ObjectId): Promise<ObjectId | null> {
	let current = hash;
	for (;;) {
		const raw = await readObject(ctx, current);
		if (raw.type === "tree") return current;
		if (raw.type === "commit") return parseCommit(raw.content).tree;
		if (raw.type !== "tag") return null;
		current = parseTag(raw.content).object;
	}
}

/** Resolve a cwd-relative path argument to a spec, or null when it leaves the repository. */
function resolveSpec(raw: string, prefix: string, workTree: string | null): string | null {
	const selectsContents = raw.endsWith("/") || /(^|\/)\.\.?$/.test(raw);
	let path: string;
	if (raw.startsWith("/")) {
		if (!workTree) return null;
		path = relative(workTree, raw);
	} else {
		path = join(prefix, raw);
	}
	path = path.replace(/\/$/, "");
	if (path === ".") path = "";
	if (path === ".." || path.startsWith("../")) return null;
	return selectsContents && path !== "" ? `${path}/` : path;
}

async function collect(
	ctx: GitRepo,
	treeHash: ObjectId,
	base: string,
	out: ListedEntry[],
	opts: WalkOptions,
): Promise<void> {
	const raw = await readObject(ctx, treeHash);
	for (const entry of parseTree(raw.content).entries) {
		const path = base ? `${base}/${entry.name}` : entry.name;
		if (opts.specs.length > 0 && !opts.specs.some((spec) => specMatches(spec, path, entry.mode))) {
			continue;
		}
		if (entry.mode === FileMode.DIRECTORY) {
			const descend = opts.recursive || opts.specs.some((spec) => spec.startsWith(`${path}/`));
			if (!descend || opts.showTrees) out.push({ ...entry, path });
			if (descend) await collect(ctx, entry.hash, path, out, opts);
			continue;
		}
		if (opts.treesOnly && entry.mode !== FileMode.SUBMODULE) continue;
		out.push({ ...entry, path });
	}
}

function specMatches(spec: string, path: string, mode: string): boolean {
	if (spec === "") return true;
	const selectsContents = spec.endsWith("/");
	const specPath = selectsContents ? spec.slice(0, -1) : spec;
	if (path === specPath) {
		return !selectsContents || mode === FileMode.DIRECTORY || mode === FileMode.SUBMODULE;
	}
	if (path.startsWith(`${specPath}/`)) return true;
	return mode === FileMode.DIRECTORY && specPath.startsWith(`${path}/`);
}

function objectType(mode: string): "tree" | "commit" | "blob" {
	if (mode === FileMode.DIRECTORY) return "tree";
	if (mode === FileMode.SUBMODULE) return "commit";
	return "blob";
}

const C_ESCAPES: Record<number, string> = {
	0x07: "\\a",
	0x08: "\\b",
	0x09: "\\t",
	0x0a: "\\n",
	0x0b: "\\v",
	0x0c: "\\f",
	0x0d: "\\r",
	0x22: '\\"',
	0x5c: "\\\\",
};

/** Quote a path like git's `quote_c_style` with `core.quotePath` enabled. */
function quotePath(path: string): string {
	const bytes = new TextEncoder().encode(path);
	let out = "";
	let quoted = false;
	for (const byte of bytes) {
		const escape = C_ESCAPES[byte];
		if (escape) {
			out += escape;
			quoted = true;
		} else if (byte < 0x20 || byte >= 0x7f) {
			out += `\\${byte.toString(8).padStart(3, "0")}`;
			quoted = true;
		} else {
			out += String.fromCharCode(byte);
		}
	}
	return quoted ? `"${out}"` : path;
}
