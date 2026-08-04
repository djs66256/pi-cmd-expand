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
for (const event of ["message_end", "before_agent_start"]) {
	assert.equal(
		typeof handlers[event],
		"function",
		`${event} handler must be registered by the extension`,
	);
}

// Hooks this extension deliberately does NOT register. These cover all
// the boundaries that lock the scope: a stray registration on any of
// these would break pi's native behaviour or change the contract.
for (const event of ["input", "user_bash", "tool_call", "tool_result"]) {
	assert.equal(
		handlers[event],
		undefined,
		`${event} handler must NOT be registered -- see "What is NOT expanded" in the README`,
	);
}

const ctx = { cwd: process.cwd() };

// ---------------------------------------------------------------------------
// message_end: `!cmd` after template / skill expansion
// ---------------------------------------------------------------------------
// The single expansion path for user input. Catches both directly-typed
// `!cmd` (where the agent-session prompt flow lands the raw `!cmd` in
// the user message because there is no longer an `input` hook to
// rewrite it) and `!cmd` baked into a prompt-template / skill body
// (where the body only materialises into the user message after
// template expansion, so no pre-expansion hook could see it).
// ---------------------------------------------------------------------------
// message_end: post-template / post-skill user message
// (Also covers the directly-typed case now that the `input` hook is
// removed -- the unexpanded `!cmd` lands in the user message and is
// expanded here, just like for a prompt template body.)
// ---------------------------------------------------------------------------

describe("message_end (`!cmd` after template / skill expansion, or directly typed)", () => {
	test("fenced form in a template-expanded user message is expanded", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "before\n!```sh\necho F\n```\nafter",
						},
					],
				},
			},
			ctx,
		);
		assert.ok(r?.message, "message_end should return a replacement message");
		const newText = r.message.content[0].text;
		assert.equal(newText, "before\nF\nafter");
		assert.doesNotMatch(newText, /!\`\`\`/);
	});

	test("directly-typed inline form is also expanded (no separate `input` hook)", async () => {
		// After the `input` hook was removed, a directly-typed `!`cmd``
		// lands in the user message verbatim and is expanded by
		// `message_end` in place. The LLM still sees the expanded text.
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "check: !`echo MID`" }],
				},
			},
			ctx,
		);
		assert.equal(r.message.content[0].text, "check: MID");
	});

	test("text without `!` -- no-op", async () => {
		// Plain text with no `!` is not a cmd-expand pattern; we leave it
		// alone. (This is also what the post-`input`-expansion state used
		// to look like before the hook was removed.)
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "result: X" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("assistant message -- skipped (we only expand user messages)", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "!`echo SHOULD_NOT_RUN`" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("toolResult message -- skipped", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "!`echo SHOULD_NOT_RUN`" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("image-only content -- skipped safely", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("multiple inline `!cmd` occurrences all replaced", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`echo A` and !`echo B`" }],
				},
			},
			ctx,
		);
		assert.equal(r.message.content[0].text, "A and B");
	});

	test("replacement message preserves non-text fields (timestamp, id)", async () => {
		const original = {
			role: "user",
			content: [{ type: "text", text: "!`echo keep-meta`" }],
			timestamp: 1700000000000,
			id: "msg-123",
		};
		const r = await handlers.message_end({ message: original }, ctx);
		assert.equal(r.message.role, "user");
		assert.equal(r.message.timestamp, 1700000000000);
		assert.equal(r.message.id, "msg-123");
		assert.equal(r.message.content[0].text, "keep-meta");
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
	test("message_end: oversized command tail-truncated, full saved to temp file", async () => {
		// Generate ~4 KB of output (well above the 2000-byte cap).
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "data: !`printf 'A%.0s' {1..4000}`" }],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.match(out, /\[Output truncated/);
		assert.doesNotMatch(out, /!\`/);
		assert.ok(
			out.length < 4000 + 200,
			"inline text must be smaller than the raw 4KB",
		);
		// The full output path is embedded in the truncation footer.
		// (os.tmpdir() differs by platform -- `/tmp` on Linux, a
		// per-user `/var/folders/.../T` on macOS, etc.)
		const m = out.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
		assert.ok(m, "footer must include the temp file path");
		const full = readFileSync(m[1], "utf-8");
		assert.equal(full.length, 4000);
		unlinkSync(m[1]);
	});

	test("message_end: small command not truncated", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "data: !`echo tiny`" }],
				},
			},
			ctx,
		);
		assert.equal(r.message.content[0].text, "data: tiny");
		assert.doesNotMatch(r.message.content[0].text, /\[Output truncated/);
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
	test("slow message_end command times out and is reported inline, never throws", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "wait: !`sleep 8 && echo DONE`" }],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.doesNotMatch(out, /DONE/, "the 8s command must be killed before it can echo DONE");
		assert.match(out, /command failed/);
		assert.match(out, /timed out after 5000ms/);
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

	test("input is not registered -- expansion is centralised in `message_end`", () => {
		// We used to register an `input` handler that rewrote the typed
		// text in place so the TUI would show the expanded output, but
		// the contract was fragile (had to be paired with `message_end`
		// for the prompt-template case anyway) and the TUI still could
		// not show the expanded text for template-sourced input. With
		// the hook removed, both directly-typed and template-sourced
		// `!cmd` are expanded by the single `message_end` hook. The
		// TUI trade-off is that the on-screen user message shows the
		// raw `!`cmd`` form; the LLM still receives the expanded text.
		assert.equal(handlers.input, undefined);
	});
});
