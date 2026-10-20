#!/usr/bin/env node
// Claude Code PreToolUse hook: before an Edit/Write, hand the agent that module's CONTEXT.agent.yaml as
// additionalContext — at most once per module every 30 minutes in a session. Plain stdout from a PreToolUse hook is not
// shown to the model, so the output is the hookSpecificOutput JSON Claude Code documents.
// It never blocks a tool call: on any error it prints nothing and exits 0.
//
// .claude/settings.json:
//   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
//       "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/<path-to-anc>/integrations/claude-code/anc-context.mjs\"" } ] } ] } }
import { hookOutput } from "../../lib/index.mjs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    input += chunk;
});
process.stdin.on("end", () => {
    try {
        const out = hookOutput(input, { root: process.env.CLAUDE_PROJECT_DIR || null });
        if (out) process.stdout.write(out);
    } catch {
        // fail open: context is a convenience, never a reason to block an edit
    }
});
