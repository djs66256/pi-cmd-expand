/**
 * pi-cmd-expand
 *
 * Expand inline command syntax in prompts and project context files
 * (AGENTS.md / CLAUDE.md) before the agent sees them.
 *
 * Supported syntax (Claude Code-compatible):
 *
 *   !`ls -la`
 *   !```sh
 *   ls -la
 *   ```
 *
 * All commands execute in the agent's current working directory
 * (ctx.cwd), not the directory of the prompt / context file.
 *
 * - For user input: hooks the `message_end` event and transforms the
 *   text in place. Works for both directly-typed `!`cmd`` and for
 *   `!`cmd`` that lives inside a prompt template / skill body
 *   (the body lands in the user message *after* template expansion,
 *   so a pre-expansion `input` hook never sees it).
 *
 * Expansion runs once per unique file content (cached by path + mtime)
 * so repeat turns do not re-execute the same shell commands.
 *
 * Command execution is delegated to pi's built-in
 * `createLocalBashOperations()`, so we inherit the same shell
 * resolution (Windows Git Bash / WSL / Unix bash / sh), output
 * sanitization (ANSI strip, control-char filter, CR normalization),
 * process-tree kill on timeout, and detached-child tracking that the
 * rest of pi uses. This keeps behaviour aligned with pi's built-in
 * `bash` tool.
 *
 * Truncation is also delegated to pi's `truncateTail`: when a
 * command's output exceeds `DEFAULT_MAX_OUTPUT_BYTES`, we keep the
 * last N bytes and persist the full output to a temp file. The temp
 * file path is surfaced inline (so the LLM can read it) in the
 * spliced text. There is no separate `BashResult` UI affordance
 * because the extension does not own the `user_bash` event.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLocalBashOperations,
	formatSize,
	type ExtensionAPI,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Soft cap on inline-command output. Beyond this we tail-truncate and
 *  persist the full output to a temp file. */
const DEFAULT_MAX_OUTPUT_BYTES = 2_000;

const bashOps = createLocalBashOperations();

interface CommandMatch {
	start: number;
	end: number;
	command: string;
}

/** What a single `!cmd` invocation produces, ready to splice in. */
interface CommandResult {
	/** Text to splice into the surrounding text. If truncated, includes
	 *  a trailing `[Output truncated. Full output: <path>]` note. */
	output: string;
}

/** Find all !`cmd` and !```lang\ncmd\n``` occurrences in `text`. */
function findCommandMatches(text: string): CommandMatch[] {
	const matches: CommandMatch[] = [];

	// Fenced form: !```lang\ncmd\n```  (lang is optional)
	// The body must not itself contain a closing ``` on its own line.
	const fencedRe = /!```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)\n```/g;
	for (const m of text.matchAll(fencedRe)) {
		matches.push({
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length,
			command: m[2],
		});
	}

	// Inline form: !`cmd`  (no newlines, no nested backticks)
	const inlineRe = /!`([^`\n]+)`/g;
	for (const m of text.matchAll(inlineRe)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		// Skip if this inline is inside an already-collected fenced block
		if (matches.some((mm) => start >= mm.start && end <= mm.end)) continue;
		matches.push({ start, end, command: m[1] });
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
		if (Number.isFinite(secs)) return `timed out after ${Math.round(secs * 1000)}ms`;
		return `timed out after ${timeoutMs}ms`;
	}
	// `bashOps.exec` also throws when the working directory does not
	// exist. Preserve the original message verbatim.
	if (err.message.startsWith("Working directory does not exist:")) {
		return err.message;
	}
	return err.message || "unknown error";
}

/** Persist `fullOutput` to a temp file and return its absolute path. */
async function writeFullOutput(fullOutput: string): Promise<string> {
	const path = join(tmpdir(), `pi-cmd-expand-${randomBytes(8).toString("hex")}.log`);
	await writeFile(path, fullOutput, "utf-8");
	return path;
}

/**
 * Execute `command` in `cwd` and return its combined stdout/stderr,
 * tail-truncated to `DEFAULT_MAX_OUTPUT_BYTES`. On overflow, the full
 * output is written to a temp file whose path is appended inline so
 * the LLM can read it on demand.
 *
 * Streams data through pi's `bashOps.exec` (which is the same backend
 * pi's built-in `bash` tool uses) so we get cross-platform shell
 * resolution, ANSI/binary sanitization, and process-tree cleanup for
 * free.
 */
async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
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
		// Failures get inlined verbatim -- they're already short and
		// truncation would only obscure the diagnostic.
		return { output: parts.join("\n") };
	}

	const raw = Buffer.concat(chunks).toString("utf-8").replace(/\n$/, "");

	// Non-zero exit: surface the output plus a failure note inline.
	// No truncation -- the failure detail (incl. partial stdout/stderr)
	// is what the LLM needs to diagnose the problem.
	if (exitCode !== null && exitCode !== 0) {
		const parts: string[] = [];
		if (raw) parts.push(raw);
		parts.push(`[command failed: exit code ${exitCode}]`);
		return { output: parts.join("\n") };
	}

	// Success path: tail-truncate if the output is over the soft cap.
	const truncation = truncateTail(raw, { maxBytes: DEFAULT_MAX_OUTPUT_BYTES });
	if (!truncation.truncated) {
		return { output: truncation.content };
	}

	const fullOutputPath = await writeFullOutput(raw);
	const footer = `\n\n[Output truncated to last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full output: ${fullOutputPath}]`;
	return { output: truncation.content + footer };
}

/**
 * Replace every `!`...`` / `!```...```` occurrence in `text` with the
 * captured output of running the enclosed command in `cwd`. Returns the
 * spliced text plus aggregate truncation metadata so callers like
 * `user_bash` can surface it to pi's UI.
 */
/**
 * Replace every `!`...`` / `!```...```` occurrence in `text` with the
 * captured output of running the enclosed command in `cwd`. The
 * replacement text already includes any truncation footer (with the
 * temp-file path) so the LLM sees the full provenance inline.
 */
async function expandText(text: string, cwd: string, timeoutMs: number): Promise<string> {
	const matches = findCommandMatches(text);
	if (matches.length === 0) return text;

	// Walk from the end so earlier indices stay valid as we splice.
	let out = text;
	for (let i = matches.length - 1; i >= 0; i--) {
		const { start, end, command } = matches[i];
		const { output } = await runCommand(command, cwd, timeoutMs);
		out = out.slice(0, start) + output + out.slice(end);
	}
	return out;
}

/** Per-file expansion cache keyed by absolute path. */
const expansionCache = new Map<string, { mtimeMs: number; size: number; expanded: string }>();

async function expandFile(
	filePath: string,
	original: string,
	cwd: string,
	timeoutMs: number,
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

	const expanded = await expandText(original, cwd, timeoutMs);
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
				typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
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

	// --- 1) `!cmd` in a typed message OR inside a prompt template / skill
	//     body -----------------------------------------------------
	// The `input` event fires before skill/template expansion, so it only
	// ever sees the raw `/template-name` text for template-sourced input
	// (no `!` in it, can't help). The `message_end` event fires after
	// template expansion with the final user message, so it sees the
	// `!`...`` whether the user typed it directly or it came from a
	// template body, and rewrites the user message in place before the
	// LLM call.
	//
	// TUI trade-off: pi renders the user message into the chat history
	// in `message_start` and does not re-render on `message_end` for the
	// user role, so the on-screen text in the chat will show the raw
	// `!`...`` form even though the LLM sees the expanded output. That
	// is a pi design gap, not something this extension can paper over.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const text = extractUserText(event.message.content);
		if (!text || !text.includes("!")) return;

		const expanded = await expandText(text, ctx.cwd, timeoutMs);
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
	// system-prompt-scoped. So if you want `!`cmd`` to expand inside
	// `AGENTS.md` / `CLAUDE.md`, this hook is not optional.
	pi.on("before_agent_start", async (event, ctx) => {
		const contextFiles = event.systemPromptOptions?.contextFiles;
		if (!contextFiles || contextFiles.length === 0) return;

		let systemPrompt = event.systemPrompt;
		let changed = false;

		for (const file of contextFiles) {
			if (!file.content.includes("!")) continue;
			const expanded = await expandFile(file.path, file.content, ctx.cwd, timeoutMs);
			if (expanded === file.content) continue;

			const next = substituteInSystemPrompt(systemPrompt, file.path, file.content, expanded);
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
