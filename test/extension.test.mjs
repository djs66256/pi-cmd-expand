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

import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const require = createRequire(import.meta.url);
const jitiMod = require("jiti");
const jiti = jitiMod.default || jitiMod;
const loader = jiti(import.meta.url, {
	moduleCache: false,
	interopDefault: true,
});

const extMod = await loader.import("../src/index.ts");
const factory = extMod.default;
assert.equal(
	typeof factory,
	"function",
	"src/index.ts must default-export a factory function",
);

const handlers = {};
factory({
	on(event, handler) {
		handlers[event] = handler;
	},
});

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
		assert.doesNotMatch(newText, /!```/);
	});

	test("bash fenced form is expanded", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{ type: "text", text: "before\n!```bash\necho B\n```\nafter" },
					],
				},
			},
			ctx,
		);
		assert.equal(r.message.content[0].text, "before\nB\nafter");
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
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
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
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /alpha/);
			assert.match(r.systemPrompt, /beta/);
			assert.doesNotMatch(r.systemPrompt, /!`/);
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
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.equal(
				r,
				undefined,
				"should not change systemPrompt when no `!` is present",
			);
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
					content: [
						{ type: "text", text: "data: !`printf 'A%.0s' {1..4000}`" },
					],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.match(out, /\[Output truncated/);
		assert.doesNotMatch(out, /!`/);
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
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /\[Output truncated/);
			assert.doesNotMatch(r.systemPrompt, /!`/);
			// Temp file path is platform-dependent (see note above).
			const m = r.systemPrompt.match(
				/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/,
			);
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
		assert.doesNotMatch(
			out,
			/DONE/,
			"the 8s command must be killed before it can echo DONE",
		);
		assert.match(out, /command failed/);
		assert.match(out, /timed out after 5000ms/);
	});
});

// ---------------------------------------------------------------------------
// @`path` / @```...``` : file reference expansion
// ---------------------------------------------------------------------------
// Inline form: @`path/to/file` (backtick-delimited, supports spaces).
// Fenced form: @```lang\npath1\npath2\n```  (one-or-more files, lang
// tag optional and ignored). Inline is bare content; fenced labels
// each file with `=== path ===`. Recursion: a file loaded via @`path`
// is itself run through `expandText`, so any further `!` / `@` patterns
// inside it are resolved. Depth-capped at 10; cycles are short-circuited
// via a per-chain visited set.
// ---------------------------------------------------------------------------

describe("message_end (`@`path` -- inline file reference)", () => {
	test("inline `@`path`` reads the file and inlines the content", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "hello.txt");
			writeFileSync(file, "Hello, world!");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `before @\`${file}\` after` }],
					},
				},
				ctx,
			);
			assert.ok(r?.message);
			assert.equal(r.message.content[0].text, "before Hello, world! after");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@`path` with spaces in the path works", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "my notes.md");
			writeFileSync(file, "spaced content");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `see @\`${file}\` here` }],
					},
				},
				ctx,
			);
			assert.equal(r.message.content[0].text, "see spaced content here");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@`path`` with absolute path uses it verbatim", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "abs.md");
			writeFileSync(file, "abs content");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.equal(r.message.content[0].text, "abs content");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("file not found is reported inline as `[file failed: ENOENT: ...]`", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "@`/no/such/file/missing.md`" }],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.match(out, /\[file failed: ENOENT/);
		// Must NOT throw -- the extension never aborts a turn on a bad
		// `@path` reference.
		assert.doesNotMatch(out, /throw/);
	});

	test("directory reference is reported inline as `[file failed: EISDIR: ...]`", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${tmp}\`` }],
					},
				},
				ctx,
			);
			assert.match(r.message.content[0].text, /\[file failed: EISDIR/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("email-like text `user@`example.com`` is NOT matched (lookbehind)", async () => {
		// The `(?<!\\w)` lookbehind refuses to match `@` preceded by a
		// word char, so `user@`example.com`` is left alone. (The intent
		// is to avoid false positives on email addresses; without the
		// lookbehind, the regex would eagerly grab `example.com` as a
		// file path.)
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "ping user@`example.com` today" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined, "email-like text must not trigger expansion");
	});

	test("inline `@` after whitespace / start-of-string still matches", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "a.md");
			writeFileSync(file, "OK");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `text @\`${file}\` end` }],
					},
				},
				ctx,
			);
			assert.equal(r.message.content[0].text, "text OK end");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("message_end (`@```...``` `-- fenced file reference, multi-file)", () => {
	test("fenced form reads each path and labels with `=== path ===`", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const fileA = join(tmp, "a.md");
			const fileB = join(tmp, "b.md");
			writeFileSync(fileA, "AAA");
			writeFileSync(fileB, "BBB");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n${fileA}\n${fileB}\n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /=== /);
			assert.match(out, /AAA/);
			assert.match(out, /BBB/);
			assert.doesNotMatch(out, /@```/);
			// Fenced form preserves order and labels each entry.
			assert.ok(
				out.indexOf("AAA") < out.indexOf("BBB"),
				"paths must appear in the order listed in the fenced body",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("blank lines and whitespace-only lines in the fenced body are skipped", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "only.md");
			writeFileSync(file, "ONLY");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n\n   \n${file}\n\n   \n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /ONLY/);
			// Only one `=== ... ===` header -- blank lines didn't spawn
			// phantom blocks.
			const headers = out.match(/^=== .* ===$/gm) ?? [];
			assert.equal(headers.length, 1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("fenced form with language tag (ignored) works the same", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "tagged.md");
			writeFileSync(file, "tagged body");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`\`\`md\n${file}\n\`\`\`` }],
					},
				},
				ctx,
			);
			assert.match(r.message.content[0].text, /tagged body/);
			assert.match(
				r.message.content[0].text,
				new RegExp(`=== .*${file}.* ===`),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@` inside a fenced `!``` block is just text (not expanded)", async () => {
		// The fenced `!``` body is shell code. The inline `@` inside is
		// not a file reference; it's literal shell text that the command
		// will receive as input.
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "inside.txt");
			writeFileSync(file, "SHOULD_NOT_LOAD");
			// The fenced command is `echo @`...`` ` (with escaped backticks).
			// It echoes the literal `@`path`` text -- not the file content.
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `!\`\`\`sh\necho 'see @\\\`${file}\\\`' \n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.ok(!/SHOULD_NOT_LOAD/.test(out), "file must not be loaded");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@` inside a fenced `@``` block is just a literal path (not expanded)", async () => {
		// Symmetric to the previous test: the fenced `@``` body is the
		// list of paths. An inline `@` inside is one more literal path
		// (which won't exist and will fail with ENOENT).
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const realFile = join(tmp, "real.md");
			writeFileSync(realFile, "REAL");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n${realFile}\n@\`/no/such/path\`\n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /REAL/);
			// The inline `@` was NOT recursed into; it sits inside the
			// fenced body and was treated as a literal path line. Since
			// the path doesn't exist, it produces a `[file failed: ...]`.
			assert.match(out, /\[file failed: ENOENT/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("message_end (`@path` recursion: file content is itself expanded)", () => {
	test("file containing `@`path`` is recursively expanded", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "inner.md");
			const outer = join(tmp, "outer.md");
			writeFileSync(inner, "INNER-CONTENT");
			writeFileSync(outer, `outer text begin\n@\`${inner}\`\nouter text end`);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `load: @\`${outer}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /outer text begin/);
			assert.match(out, /INNER-CONTENT/);
			assert.match(out, /outer text end/);
			// No raw `@`` left in the output.
			assert.doesNotMatch(out, /@`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("file containing `` !`cmd` `` has its commands executed", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const f = join(tmp, "with-cmd.md");
			writeFileSync(f, "header\n!`echo FROM-CMD`\nfooter");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${f}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /header/);
			assert.match(out, /FROM-CMD/);
			assert.match(out, /footer/);
			assert.doesNotMatch(out, /!`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("circular reference (A → B → A) is short-circuited inline", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "a.md");
			const b = join(tmp, "b.md");
			// A references B; B references A. Without cycle detection
			// this would loop until MAX_RECURSION_DEPTH killed it.
			writeFileSync(a, `A-start\n@\`${b}\`\nA-end`);
			writeFileSync(b, `B-start\n@\`${a}\`\nB-end`);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${a}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /A-start/);
			assert.match(out, /B-start/);
			assert.match(out, /\[file skipped: circular reference/);
			// The cycle is detected and reported inline; expansion
			// terminates without ever recursing forever.
			assert.doesNotMatch(out, /throw/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("recursion stops at MAX_RECURSION_DEPTH with unresolved `@` syntax left inline", async () => {
		// Build a 12-deep chain of files: 0.md references 1.md, which
		// references 2.md, ... up to 11.md. With MAX_RECURSION_DEPTH=10,
		// the deepest level is returned with its `@` reference still
		// visible inline.
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const depth = 12;
			const files = [];
			for (let i = 0; i < depth; i++) {
				files.push(join(tmp, `lvl${i}.md`));
			}
			for (let i = 0; i < depth; i++) {
				if (i === depth - 1) {
					writeFileSync(files[i], `LEAF-${i}`);
				} else {
					writeFileSync(files[i], `LEVEL-${i}\n@\`${files[i + 1]}\`\nEND-${i}`);
				}
			}
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${files[0]}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			// Some early levels resolved successfully.
			assert.match(out, /LEVEL-0/);
			// Some late level was capped -- the @`...` syntax survived.
			assert.match(out, /@`/);
			// No exceptions thrown.
			assert.doesNotMatch(out, /throw/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// @-file truncation: > DEFAULT_MAX_FILE_BYTES (10 KB) gets tail-truncated
// ---------------------------------------------------------------------------

describe("truncation (file content > 10000 bytes)", () => {
	test("message_end: large inline `@`file` is tail-truncated, full saved to temp file", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "huge.md");
			// ~15 KB, well above the 10 KB cap.
			const original = "Z".repeat(15_000);
			writeFileSync(file, original);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.ok(r?.message);
			const out = r.message.content[0].text;
			assert.match(out, /\[Output truncated/);
			// No raw `@`` syntax in the output.
			assert.doesNotMatch(out, /@`/);
			assert.ok(
				out.length < 15_000 + 200,
				`inline text must be smaller than raw 15KB (got ${out.length})`,
			);
			const m = out.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
			assert.ok(m, "footer must include the temp file path");
			// The temp file contains the FULL (un-truncated) file content.
			const full = readFileSync(m[1], "utf-8");
			assert.equal(full.length, 15_000);
			unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("message_end: small inline `@`file` is not truncated", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "small.md");
			writeFileSync(file, "tiny");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.equal(r.message.content[0].text, "tiny");
			assert.doesNotMatch(r.message.content[0].text, /\[Output truncated/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("before_agent_start: large `@`file` in AGENTS.md gets truncation footer", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "inner.md");
			writeFileSync(inner, "Q".repeat(12_000));
			const agents = join(tmp, "AGENTS.md");
			const original = `context: @\`${inner}\``;
			writeFileSync(agents, original);
			const sys = `<project_instructions path="${agents}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: agents, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /\[Output truncated/);
			assert.doesNotMatch(r.systemPrompt, /@`/);
			const m = r.systemPrompt.match(
				/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/,
			);
			if (m) unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// before_agent_start: `@`path` inside AGENTS.md / CLAUDE.md
// ---------------------------------------------------------------------------

describe("before_agent_start (context file `@`path` expansion)", () => {
	test("AGENTS.md-style block with inline `@`path`` is substituted", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "alpha.md");
			writeFileSync(inner, "ALPHA");
			const file = join(tmp, "AGENTS.md");
			const original = `refs: @\`${inner}\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /ALPHA/);
			assert.doesNotMatch(r.systemPrompt, /@`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("AGENTS.md with fenced `@``` -- multi-file substitutes labeled output", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "x.md");
			const b = join(tmp, "y.md");
			writeFileSync(a, "X-CONTENT");
			writeFileSync(b, "Y-CONTENT");
			const file = join(tmp, "AGENTS.md");
			const original = `@\`\`\`\n${a}\n${b}\n\`\`\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /X-CONTENT/);
			assert.match(r.systemPrompt, /Y-CONTENT/);
			assert.match(r.systemPrompt, /=== /);
			assert.doesNotMatch(r.systemPrompt, /@```/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("context file with `@`path`` and `!`cmd`` -- both expand", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "f.md");
			writeFileSync(inner, "FROM-FILE");
			const file = join(tmp, "AGENTS.md");
			const original = `cmd: !\`echo FROM-CMD\` file: @\`${inner}\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /FROM-CMD/);
			assert.match(r.systemPrompt, /FROM-FILE/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("context file with neither `!` nor `@` -- no-op", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "static prose with no commands or file refs";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
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
