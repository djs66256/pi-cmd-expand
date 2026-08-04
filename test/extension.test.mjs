/**
 * End-to-end tests for the pi-cmd-expand extension.
 *
 * Run with: node --test test/
 *
 * Uses the built-in `node:test` runner (Node 20+) so there is no
 * extra test-framework dependency. The extension is a TypeScript
 * file, so we load it through jiti (already a devDep) and exercise
 * each event handler with a hand-built ExtensionAPI stub.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const jitiMod = require("jiti");
const jiti = jitiMod.default || jitiMod;
const loader = jiti(import.meta.url, { moduleCache: false, interopDefault: true });

const extMod = await loader.import("../src/index.ts");
const factory = extMod.default;
assert.equal(typeof factory, "function", "src/index.ts must default-export a factory function");

const handlers = {};
factory({ on(event, handler) { handlers[event] = handler; } });

// Hooks this extension DOES register (expansion paths).
for (const event of ["input", "before_agent_start"]) {
	assert.equal(
		typeof handlers[event],
		"function",
		`${event} handler must be registered by the extension`,
	);
}

// Hooks this extension deliberately does NOT register. These cover all
// the boundaries that lock the scope: a stray registration on any of
// these would break pi's native behaviour or change the contract.
for (const event of ["user_bash", "tool_call", "tool_result"]) {
	assert.equal(
		handlers[event],
		undefined,
		`${event} handler must NOT be registered -- see "What is NOT expanded" in the README`,
	);
}

const ctx = { cwd: process.cwd() };

// ---------------------------------------------------------------------------
// input: `!cmd` anywhere in the typed message
// ---------------------------------------------------------------------------

describe("input (`!cmd` anywhere in the typed message)", () => {
	test("inline form substituted into the typed text", async () => {
		const r = await handlers.input(
			{ text: "check: !`echo MID`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "check: MID");
	});

	test("fenced form substituted", async () => {
		const r = await handlers.input(
			{ text: "before\n!```sh\necho F\n```\nafter", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "before\nF\nafter");
	});

	test("fenced without language tag", async () => {
		const r = await handlers.input(
			{ text: "x !```\necho hi\n``` y", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "x hi y");
	});

	test("multiple inline `!cmd` occurrences all replaced", async () => {
		const r = await handlers.input(
			{ text: "!`echo A` and !`echo B`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "A and B");
	});

	test("inline inside a fenced body is NOT a separate match", async () => {
		// `!`echo nested` inside the fenced body is just literal text,
		// not a separate inline expansion.
		const r = await handlers.input(
			{ text: "!```sh\necho `echo nested`\n```", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		// The fenced body should run as-is, producing whatever the inner
		// command outputs. We just check the wrapper is gone.
		assert.doesNotMatch(r.text, /!\`\`\`/);
		assert.doesNotMatch(r.text, /```$/);
	});

	test("plain text without `!` -- no transform", async () => {
		const r = await handlers.input({ text: "plain text", source: "interactive" }, ctx);
		assert.equal(r, undefined);
	});

	test("text with `!` but no backticks -- no transform", async () => {
		// `!ls` (no backticks) is NOT a cmd-expand pattern, so we leave it
		// alone for pi's normal skill/template expansion to handle.
		const r = await handlers.input({ text: "!ls", source: "interactive" }, ctx);
		assert.equal(r, undefined);
	});

	test("non-interactive source (rpc, extension) skipped", async () => {
		const r = await handlers.input({ text: "!`echo X`", source: "rpc" }, ctx);
		assert.equal(r, undefined);
	});

	test("transform uses ctx.cwd", async () => {
		const r = await handlers.input(
			{ text: "cwd: !`pwd -P`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "cwd: " + realpathSync(ctx.cwd));
	});
});

// ---------------------------------------------------------------------------
// before_agent_start: AGENTS.md / CLAUDE.md content
// ---------------------------------------------------------------------------

describe("before_agent_start (context file expansion)", () => {
	test("AGENTS.md-style block substituted", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "files: !`echo alpha` !`echo beta`";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: { contextFiles: [{ path: file, content: original }] },
				},
				ctx,
			);
			assert.match(r.systemPrompt, /alpha/);
			assert.match(r.systemPrompt, /beta/);
			assert.doesNotMatch(r.systemPrompt, /!\`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no context files -- no-op", async () => {
		const r = await handlers.before_agent_start(
			{ systemPrompt: "no files", systemPromptOptions: {} },
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("context file without `!` -- no-op", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "static content with no commands";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: { contextFiles: [{ path: file, content: original }] },
				},
				ctx,
			);
			assert.equal(r, undefined, "should not change systemPrompt when no `!` is present");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Truncation: command output > 2 000 bytes
// ---------------------------------------------------------------------------

describe("truncation (output > 2000 bytes)", () => {
	test("input transform: oversized command tail-truncated, full saved to temp file", async () => {
		// Generate ~4 KB of output (well above the 2000-byte cap).
		const r = await handlers.input(
			{ text: "data: !`printf 'A%.0s' {1..4000}`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.match(r.text, /\[Output truncated/);
		assert.doesNotMatch(r.text, /!\`/);
		assert.ok(
			r.text.length < 4000 + 200,
			"inline text must be smaller than the raw 4KB",
		);
		// The full output path is embedded in the truncation footer.
		// (os.tmpdir() differs by platform -- `/tmp` on Linux, a
		// per-user `/var/folders/.../T` on macOS, etc.)
		const m = r.text.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
		assert.ok(m, "footer must include the temp file path");
		const full = readFileSync(m[1], "utf-8");
		assert.equal(full.length, 4000);
		unlinkSync(m[1]);
	});

	test("input transform: small command not truncated", async () => {
		const r = await handlers.input(
			{ text: "data: !`echo tiny`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.equal(r.text, "data: tiny");
		assert.doesNotMatch(r.text, /\[Output truncated/);
	});

	test("before_agent_start: oversized command gets truncation footer in system prompt", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "blob: !`printf 'C%.0s' {1..4000}`";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: { contextFiles: [{ path: file, content: original }] },
				},
				ctx,
			);
			assert.match(r.systemPrompt, /\[Output truncated/);
			assert.doesNotMatch(r.systemPrompt, /!\`/);
			// Temp file path is platform-dependent (see note above).
			const m = r.systemPrompt.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
			if (m) unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Timeout: default 5 s
// ---------------------------------------------------------------------------

describe("timeout (default 5 s)", () => {
	test("slow input command times out and is reported inline, never throws", async () => {
		const r = await handlers.input(
			{ text: "wait: !`sleep 8 && echo DONE`", source: "interactive" },
			ctx,
		);
		assert.equal(r.action, "transform");
		assert.doesNotMatch(r.text, /DONE/, "the 8s command must be killed before it can echo DONE");
		assert.match(r.text, /command failed/);
		assert.match(r.text, /timed out after 5000ms/);
	});
});

// ---------------------------------------------------------------------------
// Scope: the `!`cmd`` expansion rule is narrow. Three things are out of
// scope, by design:
//
//   1. `user_bash` (start-of-line `!cmd`)           → pi's native `!bash`.
//   2. `tool_call` / `tool_result` for the `bash`   → the agent's own tool
//      tool                                            runs untouched.
//   3. Files the agent reads with `read`            → only AGENTS.md /
//                                                    CLAUDE.md (via
//                                                    `before_agent_start`)
//                                                    are expanded.
// ---------------------------------------------------------------------------

describe("scope (the `!cmd` expansion is intentionally narrow)", () => {
	test("user_bash is not registered -- start-of-line `!cmd` belongs to pi", () => {
		// Documenting the design contract: when the user types `!cmd` at
		// the start of a line, pi's interactive mode fires the
		// `user_bash` event. We deliberately do NOT subscribe so that
		// pi's native `!bash` handling (including `!!` to exclude from
		// context, live streaming, cancellation) keeps working as
		// designed. Backticks in `!`cmd`` are expanded by bash itself
		// via command substitution.
		assert.equal(handlers.user_bash, undefined);
	});

	test("tool_call and tool_result are not registered -- the agent's own bash tool is untouched", () => {
		// When the LLM calls pi's built-in `bash` tool, the command
		// goes straight to bashOps.exec on the agent's side. This
		// extension does not hook tool_call/tool_result, so any
		// `!`cmd`` text the LLM happens to run lands in the shell
		// literally (e.g. `` !`ls` `` would fail as a real command).
		assert.equal(handlers.tool_call, undefined);
		assert.equal(handlers.tool_result, undefined);
	});
});
