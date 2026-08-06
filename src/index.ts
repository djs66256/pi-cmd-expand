/**
 * pi-cmd-expand
 *
 * Expand inline command and file-reference syntax in prompts and
 * project context files (AGENTS.md / CLAUDE.md) before the agent
 * sees them. Two pairs of forms are supported, all Claude
 * Code-compatible:
 *
 *   !`ls -la`              -- inline shell command
 *   !```sh                 -- fenced shell command (multi-line)
 *   ls -la
 *   ```
 *   @`path/to/file`        -- inline file reference (one file)
 *   @```                   -- fenced file reference (one or more files)
 *   path/to/file_1
 *   path/to/file_2
 *   ```
 *
 * Both commands and file references resolve against the agent's
 * current working directory (ctx.cwd), never against the directory
 * of the prompt or context file.
 *
 * Every match is wrapped in a semantic tag so the LLM can tell what
 * was generated and where it came from:
 *
 *   !`ls -la`               →  <cmd source="ls -la">AUTHORS\nLICENSE\nREADME.md</cmd>
 *   !```sh\nls -la\n```     →  <cmd lang="sh" source="ls -la">…</cmd>
 *   @`./README.md`          →  <file path="./README.md">…</file>
 *   @```\na.md\nb.md\n```   →  <file path="./a.md">…</file>\n\n<file path="./b.md">…</file>
 *
 * Tag attributes carry provenance and outcome metadata
 * (`source`, `lang`, `path`, `status`, `exit-code`, `error`,
 * `inline-size`, `total-size`). Single-line content uses inline
 * tag wrapping; multi-line content gets the open/close tags on
 * their own lines for readability.
 *
 * - For user input: hooks the `message_end` event and transforms the
 *   text in place. Works for both directly-typed `!`cmd`` / `` @`path` ``
 *   and for the same syntax that lives inside a prompt template / skill
 *   body (the body lands in the user message *after* template expansion,
 *   so a pre-expansion `input` hook never sees it).
 *
 * Expansion runs once per unique file content (cached by path + mtime)
 * so repeat turns do not re-execute the same shell commands or
 * re-read the same referenced files.
 *
 * Command execution is delegated to pi's built-in
 * `createLocalBashOperations()`, so we inherit the same shell
 * resolution (Windows Git Bash / WSL / Unix bash / sh), output
 * sanitization (ANSI strip, control-char filter, CR normalization),
 * process-tree kill on timeout, and detached-child tracking that the
 * rest of pi uses. This keeps behaviour aligned with pi's built-in
 * `bash` tool.
 *
 * File reading uses plain `fs.readFile(path, "utf-8")`. A loaded file
 * is recursively expanded the same way the top-level text is: any
 * `` !`cmd` `` / `!```sh\ncmd\n``` ` / `` @`path` `` / `@```\npaths\n``` `
 * inside the loaded content is also resolved, up to a recursion-depth
 * cap (10). Cycles are short-circuited with a per-chain visited set.
 *
 * Truncation is also delegated to pi's `truncateTail`: when a command's
 * output or a file's expanded content exceeds its cap, we keep the
 * last N bytes and persist the full content to a temp file. The temp
 * file path is surfaced inline (so the LLM can read it) inside the
 * `<cmd>` / `<file>` wrap.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	createLocalBashOperations,
	type ExtensionAPI,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Soft cap on inline command output. Beyond this we tail-truncate and
 *  persist the full output to a temp file. */
const DEFAULT_MAX_OUTPUT_BYTES = 2_000;
/** Soft cap on inline file content. Same truncation policy as
 *  commands; full content is persisted to a temp file above this.
 *  Defaults larger than commands because source files tend to be
 *  larger than typical command output. */
const DEFAULT_MAX_FILE_BYTES = 10_000;
/** Hard cap on how deeply `@` references may nest. With this cap,
 *  even a chain of `a → b → c → …` references has a bounded worst
 *  case; the visited-set additionally short-circuits actual cycles
 *  long before the cap is reached. */
const MAX_RECURSION_DEPTH = 10;
/** Maximum characters in the `source` attribute of a `<cmd>` tag.
 *  Long commands are truncated to `first 17 chars + "..."` so the
 *  attribute stays at or below this limit. Only the first line of
 *  a fenced body is used; the rest of the body is still executed. */
const SOURCE_MAX_CHARS = 20;

const bashOps = createLocalBashOperations();

interface CommandMatch {
	start: number;
	end: number;
	kind: "command";
	command: string;
	/** Language tag from the fenced form (`!```sh\n...\n``` `). Empty
	 *  string for inline commands (`!`cmd``). */
	lang: string;
}

interface FileMatch {
	start: number;
	end: number;
	kind: "file";
	/** One entry for inline, one-or-more for fenced. Blank lines
	 *  inside fenced bodies are skipped. */
	paths: string[];
	/** True for `@```...``` `, false for `` @`path` ``. Currently only
	 *  controls output labelling, but the inline/fenced distinction
	 *  may grow more interesting in the future. */
	fenced: boolean;
}

type Match = CommandMatch | FileMatch;

/** What a single `!cmd` invocation produces. Captured separately from
 *  the wrapper so the splice loop can decide on attributes (status,
 *  exit-code, truncation sizes) before emitting the final tag. */
interface CommandOutcome {
	/** Body to splice in. For failed commands, includes the
	 *  `[command failed: …]` marker; for truncated commands, includes
	 *  the `[Output truncated … Full output: <path>]` footer. */
	output: string;
	/** Process exit code. `null` means execution itself failed
	 *  (timeout, cwd missing, etc.); `0` is success; non-zero is a
	 *  failing exit. */
	exitCode: number | null;
	/** Whether the output was tail-truncated. */
	truncated: boolean;
	totalBytes?: number;
	inlineBytes?: number;
}

/** What loading a single file path produces. */
interface FileOutcome {
	/** Body to splice in. For failed reads, the `[file failed: …]`
	 *  marker; for circular references, `[file skipped: circular
	 *  reference: …]`; for truncated files, the truncated content
	 *  + `[Output truncated …]` footer. */
	output: string;
	/** Outcome classification. */
	status: "ok" | "failed" | "circular" | "truncated";
	/** Only present when `status === "failed"`. */
	error?: string;
	/** Only present when `status === "truncated"`. */
	totalBytes?: number;
	inlineBytes?: number;
}

/** Find all `!`cmd`` / `!```sh\ncmd\n``` ` / `` @`path` `` /
 *  `@```\npaths\n``` ` occurrences in `text`. Within each character
 *  class (`!` or `@`), fenced takes priority over inline; the two
 *  character classes do not interfere with each other (an inline
 *  `!` inside a fenced `@` block, or vice-versa, is just text). */
function findAllMatches(text: string): Match[] {
	const matches: Match[] = [];
	/** Fenced ranges of either class. Inline matches (of either class)
	 *  inside any fenced range are skipped — the fenced body is opaque
	 *  to further inline expansion. */
	const fencedRanges: Array<[number, number]> = [];

	// Fenced command: !```lang\ncmd\n```  (lang is optional)
	const cmdFencedRe = /!```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;
	for (const m of text.matchAll(cmdFencedRe)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		matches.push({
			start,
			end,
			kind: "command",
			command: m[2],
			lang: m[1],
		});
		fencedRanges.push([start, end]);
	}

	// Fenced file reference: @```lang\npaths\n```
	const fileFencedRe = /@```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;
	for (const m of text.matchAll(fileFencedRe)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		matches.push({
			start,
			end,
			kind: "file",
			paths: m[2].split("\n"),
			fenced: true,
		});
		fencedRanges.push([start, end]);
	}

	// Inline command: !`cmd`
	const cmdInlineRe = /!`([^`\n]+)`/g;
	for (const m of text.matchAll(cmdInlineRe)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		if (fencedRanges.some(([s, e]) => start >= s && end <= e)) continue;
		matches.push({ start, end, kind: "command", command: m[1], lang: "" });
	}

	// Inline file reference: @`path`  (no newlines, no nested backticks).
	// The `(?<!\w)` lookbehind refuses to match when `@` is preceded by a
	// word character, which avoids false positives on email-like text
	// such as `user@`example.com`` (the `r` before `@` excludes it).
	// `@` at start-of-string, after whitespace, or after punctuation
	// still matches.
	const fileInlineRe = /(?<!\w)@`([^`\n]+)`/g;
	for (const m of text.matchAll(fileInlineRe)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		if (fencedRanges.some(([s, e]) => start >= s && end <= e)) continue;
		matches.push({ start, end, kind: "file", paths: [m[1]], fenced: false });
	}

	matches.sort((a, b) => a.start - b.start);
	return matches;
}

/**
 * Map an error thrown by pi's `bashOps.exec` to the same textual
 * detail the previous `child_process.exec` wrapper produced. Keeps
 * downstream `[command failed: ...]` lines byte-compatible with the
 * pre-refactor output.
 */
function describeExecError(err: unknown, timeoutMs: number): string {
	if (!(err instanceof Error)) return String(err) || "unknown error";
	// `bashOps.exec` throws `Error("timeout:<seconds>")` when the
	// configured timeout elapses. Surface that in milliseconds so the
	// caller sees the same unit it configured.
	if (err.message.startsWith("timeout:")) {
		const secs = Number(err.message.slice("timeout:".length));
		if (Number.isFinite(secs))
			return `timed out after ${Math.round(secs * 1000)}ms`;
		return `timed out after ${timeoutMs}ms`;
	}
	// `bashOps.exec` also throws when the working directory does not
	// exist. Preserve the original message verbatim.
	if (err.message.startsWith("Working directory does not exist:")) {
		return err.message;
	}
	return err.message || "unknown error";
}

/** Format a Node-style FS error as a one-line `[file failed: …]` body. */
function describeFileError(err: unknown): string {
	if (!(err instanceof Error)) return String(err) || "unknown error";
	const code = (err as NodeJS.ErrnoException).code;
	if (typeof code === "string" && code) {
		return `${code}: ${err.message}`;
	}
	return err.message || "unknown error";
}

/** Persist `fullOutput` to a temp file and return its absolute path. */
async function writeFullOutput(fullOutput: string): Promise<string> {
	const path = join(
		tmpdir(),
		`pi-cmd-expand-${randomBytes(8).toString("hex")}.log`,
	);
	await writeFile(path, fullOutput, "utf-8");
	return path;
}

/** Choose single vs double quotes for an attribute value, preferring
 *  double quotes and falling back to single quotes only if the value
 *  contains a `"`. (Both quotes in one value would still break, but
 *  that combination is exotic enough to ignore.) */
function quoteAttr(value: string): string {
	return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** Truncate the `source` attribute for `<cmd>` tags so it stays at or
 *  below `SOURCE_MAX_CHARS`. For multi-line bodies (fenced commands),
 *  only the first line is used as the source — the full body is still
 *  executed, the source attribute is just a provenance hint. */
function truncateSource(source: string): string {
	const firstLine = source.split("\n")[0];
	if (firstLine.length <= SOURCE_MAX_CHARS) return firstLine;
	return firstLine.slice(0, SOURCE_MAX_CHARS - 3) + "...";
}

/**
 * Wrap `content` with `<tagName attrs>` / `</tagName>`. Single-line
 * content (after stripping a trailing newline) is wrapped inline —
 * tags sit on the same line as the content. Multi-line content is
 * wrapped across three lines: open tag, content, close tag. The
 * trailing newline is always stripped from the body so we don't
 * produce a stray `\n` right before the close tag.
 */
function wrapWithTag(tagName: string, attrs: string, content: string): string {
	const body = content.replace(/\n$/, "");
	const lineCount = body === "" ? 0 : body.split("\n").length;
	if (lineCount <= 1) {
		return `<${tagName}${attrs}>${body}</${tagName}>`;
	}
	return `<${tagName}${attrs}>\n${body}\n</${tagName}>`;
}

/** Build the `<cmd>` wrapper for a `CommandOutcome`. */
function formatCmdWrap(
	outcome: CommandOutcome,
	command: string,
	lang: string,
): string {
	const attrs: string[] = [];
	attrs.push(` source=${quoteAttr(truncateSource(command))}`);
	if (lang) attrs.push(` lang=${quoteAttr(lang)}`);
	if (outcome.exitCode !== null && outcome.exitCode !== 0) {
		attrs.push(
			` status="failed" exit-code=${quoteAttr(String(outcome.exitCode))}`,
		);
	} else if (outcome.truncated) {
		attrs.push(
			` status="truncated" inline-size=${quoteAttr(String(outcome.inlineBytes))} total-size=${quoteAttr(String(outcome.totalBytes))}`,
		);
	}
	return wrapWithTag("cmd", attrs.join(""), outcome.output);
}

/** Build the `<file>` wrapper for a `FileOutcome`. */
function formatFileWrap(outcome: FileOutcome, path: string): string {
	const attrs: string[] = [];
	attrs.push(` path=${quoteAttr(path)}`);
	if (outcome.status === "failed") {
		attrs.push(` status="failed" error=${quoteAttr(outcome.error ?? "")}`);
	} else if (outcome.status === "circular") {
		attrs.push(` status="circular"`);
	} else if (outcome.status === "truncated") {
		attrs.push(
			` status="truncated" inline-size=${quoteAttr(String(outcome.inlineBytes))} total-size=${quoteAttr(String(outcome.totalBytes))}`,
		);
	}
	return wrapWithTag("file", attrs.join(""), outcome.output);
}

/**
 * Execute `command` in `cwd` and return a `CommandOutcome` with the
 * combined stdout/stderr (trailing newline stripped), an `exitCode`,
 * and any truncation metadata. Never throws — execution failures
 * are captured as `exitCode: null` with an inline `[command failed: …]`
 * marker in `output`.
 *
 * Streams data through pi's `bashOps.exec` (which is the same backend
 * pi's built-in `bash` tool uses) so we get cross-platform shell
 * resolution, ANSI/binary sanitization, and process-tree cleanup for
 * free.
 */
async function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<CommandOutcome> {
	const chunks: Buffer[] = [];
	let exitCode: number | null = 0;

	// `bashOps.exec` accepts `timeout` in seconds and refuses values
	// <= 0. We always have a positive `timeoutMs` from `DEFAULT_TIMEOUT_MS`,
	// so a ceiling division by 1000 is safe.
	const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));

	try {
		const result = await bashOps.exec(command, cwd, {
			onData: (data) => chunks.push(data),
			timeout: timeoutSecs,
		});
		exitCode = result.exitCode;
	} catch (err) {
		const partial = Buffer.concat(chunks).toString("utf-8").replace(/\n$/, "");
		const parts: string[] = [];
		if (partial) parts.push(partial);
		parts.push(`[command failed: ${describeExecError(err, timeoutMs)}]`);
		// Failures get inlined verbatim — they're already short and
		// truncation would only obscure the diagnostic.
		return { output: parts.join("\n"), exitCode: null, truncated: false };
	}

	const raw = Buffer.concat(chunks).toString("utf-8").replace(/\n$/, "");

	// Non-zero exit: surface the output plus a failure note inline.
	// No truncation — the failure detail (incl. partial stdout/stderr)
	// is what the LLM needs to diagnose the problem.
	if (exitCode !== null && exitCode !== 0) {
		const parts: string[] = [];
		if (raw) parts.push(raw);
		parts.push(`[command failed: exit code ${exitCode}]`);
		return { output: parts.join("\n"), exitCode, truncated: false };
	}

	// Success path: tail-truncate if the output is over the soft cap.
	const truncation = truncateTail(raw, { maxBytes: DEFAULT_MAX_OUTPUT_BYTES });
	if (!truncation.truncated) {
		return {
			output: truncation.content,
			exitCode: 0,
			truncated: false,
		};
	}

	const fullOutputPath = await writeFullOutput(raw);
	const footer = `\n\n[Output truncated to last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full output: ${fullOutputPath}]`;
	return {
		output: truncation.content + footer,
		exitCode: 0,
		truncated: true,
		inlineBytes: truncation.outputBytes,
		totalBytes: truncation.totalBytes,
	};
}

/** Resolve `relPath` against `cwd`; absolute paths are used verbatim. */
function resolveFilePath(relPath: string, cwd: string): string {
	return isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
}

/**
 * Read `relPath` (resolved against `cwd`) and return a `FileOutcome`
 * with the raw UTF-8 content on success, or a `[file failed: …]`
 * marker on error (never throws). The caller checks `status` to
 * decide whether to recurse into the content for further `@`/`!`
 * expansion.
 */
async function loadFileRaw(relPath: string, cwd: string): Promise<FileOutcome> {
	const absPath = resolveFilePath(relPath, cwd);
	try {
		const content = await fs.readFile(absPath, "utf-8");
		return { output: content, status: "ok" };
	} catch (err) {
		const errorMsg = describeFileError(err);
		return {
			output: `[file failed: ${errorMsg}]`,
			status: "failed",
			error: errorMsg,
		};
	}
}

/**
 * Load each path in a `FileMatch`, recursively expand its content
 * (so nested `!`/`@` patterns inside the loaded file are resolved
 * and themselves wrapped in their own `<cmd>` / `<file>` tags),
 * apply the per-file truncation cap, and format each path into a
 * `<file>` wrapper.
 *
 * Reads in parallel (`Promise.all`) since file I/O is independent.
 * Each parallel task uses its own copy of `visited` so a file shared
 * across tasks loads once per task — preventing races on the shared
 * set while still giving us cycle detection inside a single chain.
 */
async function expandFileReferences(
	match: FileMatch,
	cwd: string,
	timeoutMs: number,
	maxFileBytes: number,
	depth: number,
	visited: Set<string>,
): Promise<string> {
	const tasks = match.paths.map(async (rawPath) => {
		const p = rawPath.trim();
		if (!p) return null;
		const absPath = resolveFilePath(p, cwd);
		if (visited.has(absPath)) {
			// Circular reference: emit a clear inline marker instead of
			// recursing (which would loop until the depth cap kills it).
			const outcome: FileOutcome = {
				output: `[file skipped: circular reference: ${p}]`,
				status: "circular",
			};
			return formatFileWrap(outcome, p);
		}
		const rawOutcome = await loadFileRaw(p, cwd);
		let outcome = rawOutcome;
		// Only recurse into successfully-read files. An error or
		// circular outcome must not be parsed for further `@` refs.
		if (outcome.status === "ok") {
			const newVisited = new Set(visited);
			newVisited.add(absPath);
			const expanded = await expandText(
				outcome.output,
				cwd,
				timeoutMs,
				maxFileBytes,
				depth + 1,
				newVisited,
			);
			const truncation = truncateTail(expanded, { maxBytes: maxFileBytes });
			if (!truncation.truncated) {
				outcome = { output: truncation.content, status: "ok" };
			} else {
				const fullOutputPath = await writeFullOutput(expanded);
				const footer = `\n\n[Output truncated to last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full output: ${fullOutputPath}]`;
				outcome = {
					output: truncation.content + footer,
					status: "truncated",
					inlineBytes: truncation.outputBytes,
					totalBytes: truncation.totalBytes,
				};
			}
		}
		return formatFileWrap(outcome, p);
	});
	const blocks = (await Promise.all(tasks)).filter(
		(b): b is string => b !== null,
	);
	return blocks.join("\n\n");
}

/**
 * Replace every `!`cmd`` / `!```sh\ncmd\n``` ` / `` @`path` `` /
 * `@```\npaths\n``` ` occurrence in `text` with the corresponding
 * `<cmd>` / `<file>` wrap. Walks matches from the end so earlier
 * byte offsets stay valid as we splice. Recurses into loaded file
 * content (via the `depth` / `visited` parameters) so `@` references
 * can chain.
 */
async function expandText(
	text: string,
	cwd: string,
	timeoutMs: number,
	maxFileBytes: number,
	depth = 0,
	visited: Set<string> = new Set(),
): Promise<string> {
	// Hard cap on how deep `@` expansion may nest. Beyond this, the
	// text is returned with whatever `@` references it still contains
	// unexpanded — the LLM sees the unresolved syntax and can decide
	// what to do (e.g., use `read`).
	if (depth >= MAX_RECURSION_DEPTH) return text;

	const matches = findAllMatches(text);
	if (matches.length === 0) return text;

	let out = text;
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		let replacement: string;
		if (m.kind === "command") {
			const outcome = await runCommand(m.command, cwd, timeoutMs);
			replacement = formatCmdWrap(outcome, m.command, m.lang);
		} else {
			replacement = await expandFileReferences(
				m,
				cwd,
				timeoutMs,
				maxFileBytes,
				depth,
				visited,
			);
		}
		out = out.slice(0, m.start) + replacement + out.slice(m.end);
	}
	return out;
}

/** Per-file expansion cache keyed by absolute path. */
const expansionCache = new Map<
	string,
	{ mtimeMs: number; size: number; expanded: string }
>();

async function expandFile(
	filePath: string,
	original: string,
	cwd: string,
	timeoutMs: number,
	maxFileBytes: number,
): Promise<string> {
	let mtimeMs = 0;
	let size = original.length;
	try {
		const stat = await fs.stat(filePath);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch {
		// File may have been deleted between discovery and expansion.
		// Fall through with a synthetic key so we still cache the result
		// for the duration of this session.
	}

	const cached = expansionCache.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached.expanded;
	}

	const expanded = await expandText(original, cwd, timeoutMs, maxFileBytes);
	expansionCache.set(filePath, { mtimeMs, size, expanded });
	return expanded;
}

/** Escape a literal string for embedding into a RegExp. */
function reEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the concatenated text from a message's `content` field.
 * The `message_end` event always passes content as a `ContentBlock[]`
 * (see agent-session.js:865 where the user message is built), but we
 * also accept a bare string in case a future pi version passes one.
 * Mirrors `contentText` from `@earendil-works/pi-ai` but inlined to
 * avoid adding a transitive dep just for one 4-line helper.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text?: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text",
		)
		.map((block) => block.text ?? "")
		.join("\n");
}

/**
 * Substitute the expanded content of a context file into the system prompt.
 * The project context is rendered as:
 *   <project_instructions path="FILEPATH">\n{content}\n</project_instructions>
 * so we locate that exact block and swap its body.
 */
function substituteInSystemPrompt(
	systemPrompt: string,
	filePath: string,
	originalContent: string,
	expandedContent: string,
): string {
	const pathEsc = reEscape(filePath);
	const re = new RegExp(
		`(<project_instructions\\s+path="${pathEsc}"[^>]*>\\n)([\\s\\S]*?)(\\n</project_instructions>)`,
	);
	return systemPrompt.replace(re, (_match, head, _body, tail) => {
		// Only replace if the body still matches what we expect. If a previous
		// hook already mutated it, leave it alone.
		return _body === originalContent ? head + expandedContent + tail : _match;
	});
}

export default function cmdExpandExtension(pi: ExtensionAPI) {
	const timeoutMs = DEFAULT_TIMEOUT_MS;
	const maxFileBytes = DEFAULT_MAX_FILE_BYTES;

	// We deliberately do NOT register a `user_bash` handler. When the
	// user types `!cmd` at the start of a line, pi's interactive mode
	// intercepts it as a raw bash invocation and runs it natively:
	//   - `!ls`         → pi runs `ls` in bash, shows the listing.
	//   - `` !`ls` ``   → pi runs `` `ls` `` in bash, which bash itself
	//                     expands via command substitution, so the user
	//                     still sees the same listing.
	// Hooking `user_bash` here would double-handle the command and
	// break pi's own `!!` (excludeFromContext) / cancellation / live
	// streaming semantics. So we let pi own this path.

	// --- 1) `!cmd` / `@path` in a typed message OR inside a prompt
	//     template / skill body ------------------------------------
	// The `input` event fires before skill/template expansion, so it only
	// ever sees the raw `/template-name` text for template-sourced input
	// (no `!` or `@` in it, can't help). The `message_end` event fires
	// after template expansion with the final user message, so it sees
	// the `!`...`` / `` @`path` `` whether the user typed it directly or
	// it came from a template body, and rewrites the user message in
	// place before the LLM call.
	//
	// TUI trade-off: pi renders the user message into the chat history
	// in `message_start` and does not re-render on `message_end` for the
	// user role, so the on-screen text in the chat will show the raw
	// `!`...`` / `` @`path` `` form even though the LLM sees the
	// expanded output. That is a pi design gap, not something this
	// extension can paper over.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const text = extractUserText(event.message.content);
		if (!text) return;
		// Fast path: nothing to expand if neither trigger character is
		// present. Without this, we'd call `findAllMatches` for every
		// message, even plain prose.
		if (!text.includes("!") && !text.includes("@")) return;

		const expanded = await expandText(text, ctx.cwd, timeoutMs, maxFileBytes);
		if (expanded === text) return;
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: expanded }],
			},
		};
	});

	// --- 2) Project context files (AGENTS.md / CLAUDE.md) ----------------
	// `before_agent_start` is the ONLY hook in pi that exposes the
	// fully-assembled system prompt AND the structured `contextFiles`
	// list (with `path` and `content`). No other event carries either:
	// `agent_start` / `agent_end` / `context` / `message_end` /
	// `turn_end` are all message- or lifecycle-scoped, not
	// system-prompt-scoped. So if you want `!`cmd`` / `` @`path` `` to
	// expand inside `AGENTS.md` / `CLAUDE.md`, this hook is not optional.
	pi.on("before_agent_start", async (event, ctx) => {
		const contextFiles = event.systemPromptOptions?.contextFiles;
		if (!contextFiles || contextFiles.length === 0) return;

		let systemPrompt = event.systemPrompt;
		let changed = false;

		for (const file of contextFiles) {
			if (!file.content.includes("!") && !file.content.includes("@")) continue;
			const expanded = await expandFile(
				file.path,
				file.content,
				ctx.cwd,
				timeoutMs,
				maxFileBytes,
			);
			if (expanded === file.content) continue;

			const next = substituteInSystemPrompt(
				systemPrompt,
				file.path,
				file.content,
				expanded,
			);
			if (next !== systemPrompt) {
				systemPrompt = next;
				changed = true;
			}
		}

		if (changed) {
			return { systemPrompt };
		}
	});
}
