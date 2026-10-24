// ANC selftest — builds throwaway workspaces in the OS temp dir, plants one violation per rule, and
// requires each to go RED for the stated reason. Also proves the library imports without side effects.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    check,
    classifyOracle,
    hookOutput,
    PLACEHOLDER_RULE,
    resolveContext,
    stringifyYaml,
    verify,
} from "./index.mjs";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

function contract(name, extra = {}) {
    return {
        module: {
            name,
            package: `@fx/${name}`,
            purpose: `Fixture package ${name}`,
            domain: "platform",
            path: `packages/${name}/`,
        },
        dependencies: { reads_from: [], writes_to: [] },
        invariants: [
            { id: `${name}1`, rule: `${name} keeps its promise`, type: "data", test: null },
        ],
        authority: {
            autonomous: ["edit fixture code"],
            founder_approval: ["change the fixture's public API"],
        },
        blast_radius: { level: "low" },
        ...extra,
    };
}

/** A two-package workspace that passes `check`; `mutate(files)` edits the file map before writing. */
function fixture(mutate = () => {}) {
    const files = {
        "package.json": {
            name: "fixture",
            private: true,
            workspaces: ["packages/*"],
            scripts: { "check:x": "node scripts/ok.mjs" },
        },
        "scripts/ok.mjs": "process.exit(0);\n",
        "scripts/fail.mjs": "process.exit(3);\n",
        "packages/a/package.json": {
            name: "@fx/a",
            version: "1.0.0",
            dependencies: { "@fx/b": "1.0.0" },
        },
        "packages/a/CONTEXT.agent.yaml": contract("a", {
            dependencies: { reads_from: [{ module: "b", via: "import" }], writes_to: [] },
            invariants: [
                {
                    id: "a1",
                    rule: "a keeps its promise",
                    type: "data",
                    test: "node scripts/ok.mjs",
                },
            ],
        }),
        "packages/b/package.json": { name: "@fx/b", version: "1.0.0" },
        "packages/b/CONTEXT.agent.yaml": contract("b"),
    };
    mutate(files);
    const root = mkdtempSync(join(tmpdir(), "anc-selftest-"));
    for (const [p, v] of Object.entries(files)) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        const text =
            typeof v === "string"
                ? v
                : p.endsWith(".yaml")
                  ? stringifyYaml(v)
                  : `${JSON.stringify(v, null, 2)}\n`;
        writeFileSync(join(root, p), text);
    }
    return root;
}

export function selftest({ log = console.log, error = console.error } = {}) {
    let passed = 0;
    let failed = 0;
    const roots = [];
    const ok = (name, cond, detail = "") => {
        if (cond) {
            log(`  ✓ ${name}`);
            passed++;
        } else {
            error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
            failed++;
        }
    };
    const plant = (id, mutate, expect) => {
        const root = fixture(mutate);
        roots.push(root);
        const r = check(root);
        const hit = r.failures.some((f) => expect.test(f));
        ok(
            `plant:${id}`,
            !r.ok && hit,
            r.ok ? "check stayed green" : `failures: ${r.failures.join(" | ")}`,
        );
    };
    try {
        log("ANC selftest");
        const base = fixture();
        roots.push(base);
        const b = check(base);
        ok("baseline fixture passes check", b.ok, b.failures.join(" | "));

        plant(
            "schema",
            (f) => {
                f["packages/b/CONTEXT.agent.yaml"].invariants[0].type = "not-a-type";
            },
            /packages[/\\]b[/\\]CONTEXT\.agent\.yaml: schema/,
        );
        plant(
            "authority",
            (f) => {
                f["packages/b/CONTEXT.agent.yaml"].authority.founder_approval = [];
            },
            /authority\.autonomous and authority\.founder_approval/,
        );
        plant(
            "deps-forward",
            (f) => {
                delete f["packages/a/package.json"].dependencies;
            },
            /reads_from "b" \(via import\) is not in/,
        );
        plant(
            "deps-reverse",
            (f) => {
                f["packages/c/package.json"] = { name: "@fx/c", version: "1.0.0" };
                f["packages/a/package.json"].dependencies["@fx/c"] = "1.0.0";
            },
            /depends on workspace package @fx\/c/,
        );
        plant(
            "deps-scope",
            (f) => {
                // contract says it imports workspace "b"; package.json only has an unrelated @other/b
                f["packages/a/package.json"].dependencies = { "@other/b": "1.0.0" };
            },
            /reads_from "b" \(via import\) is not in/,
        );
        plant(
            "deps-reverse-scope",
            (f) => {
                // package.json depends on workspace @fx/b and an unrelated @other/b; the contract lists only @other/b
                f["packages/a/package.json"].dependencies["@other/b"] = "1.0.0";
                f["packages/a/CONTEXT.agent.yaml"].dependencies.reads_from = [
                    { module: "@other/b", via: "import" },
                ];
            },
            /depends on workspace package @fx\/b/,
        );
        plant(
            "cycle",
            (f) => {
                f["packages/b/package.json"].devDependencies = { "@fx/a": "1.0.0" };
            },
            /cycle: @fx\/a -> @fx\/b -> @fx\/a/,
        );
        plant(
            "oracle-missing-path",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "node scripts/missing.mjs";
            },
            /path `scripts\/missing\.mjs` does not exist/,
        );
        plant(
            "oracle-missing-script",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "npm run nope";
            },
            /npm script `nope` is not defined/,
        );
        plant(
            "oracle-tautology",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "true";
            },
            /tautological/,
        );
        plant(
            "oracle-masked",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test =
                    "node scripts/fail.mjs || true";
            },
            /discarding its exit status/,
        );
        plant(
            "oracle-missing-bare-script",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "node check.mjs";
            },
            /script `check\.mjs` does not exist/,
        );
        plant(
            "oracle-tautology-chain",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "true && exit 0";
            },
            /tautological/,
        );
        plant(
            "oracle-masked-echo",
            (f) => {
                f["packages/a/CONTEXT.agent.yaml"].invariants[0].test =
                    "node scripts/fail.mjs || echo ignored";
            },
            /discarding its exit status/,
        );
        plant(
            "deps-external-exact",
            (f) => {
                // contract imports external "lodash"; package.json only has @types/lodash
                f["packages/b/package.json"].dependencies = { "@types/lodash": "4.0.0" };
                f["packages/b/CONTEXT.agent.yaml"].dependencies.reads_from = [
                    { module: "lodash", via: "import" },
                ];
            },
            /reads_from "lodash" \(via import\) is not in/,
        );
        plant(
            "placeholder",
            (f) => {
                f["packages/b/CONTEXT.agent.yaml"].invariants[0].rule = PLACEHOLDER_RULE;
            },
            /placeholder/,
        );

        const quiet = { stdio: "ignore", log: () => {} };
        let threw = "";
        try {
            verify(base, { changed: "no-such-ref-anc-selftest", stdio: "ignore", log: () => {} });
        } catch (e) {
            threw = e.message;
        }
        ok(
            "verify fails closed when git cannot diff (unknown ref, or not a repository)",
            /failed/.test(threw),
            threw || "did not throw",
        );
        let emptyErr = "";
        const emptyRoot = mkdtempSync(join(tmpdir(), "anc-selftest-empty-"));
        roots.push(emptyRoot);
        try {
            verify(emptyRoot, { all: true, stdio: "ignore", log: () => {} });
        } catch (e) {
            emptyErr = e.message;
        }
        ok(
            "verify --all fails when there are no contracts (wrong root)",
            /no CONTEXT\.agent\.yaml files/.test(emptyErr),
            emptyErr || "did not throw",
        );
        const pass = verify(base, { targets: ["packages/a"], ...quiet });
        ok(
            "verify runs a passing invariant (exit 0)",
            pass.failed === 0 && pass.runs.length === 1 && pass.runs[0].status === 0,
            JSON.stringify(pass.runs),
        );
        const failRoot = fixture((f) => {
            f["packages/a/CONTEXT.agent.yaml"].invariants[0].test = "node scripts/fail.mjs";
        });
        roots.push(failRoot);
        const fail = verify(failRoot, { targets: ["packages/a/src/index.ts"], ...quiet });
        ok(
            "plant:verify-fails",
            fail.failed === 1 && fail.runs[0].status === 3,
            JSON.stringify(fail.runs),
        );

        ok(
            "query resolves a file path to its nearest contract",
            resolveContext(base, "packages/a/src/deep/file.ts")?.doc.module.name === "a",
        );
        ok("query resolves a package name", resolveContext(base, "@fx/b")?.doc.module.name === "b");
        ok(
            "query returns null outside any contract",
            resolveContext(base, "nowhere/x.ts") === null,
        );

        const payload = JSON.stringify({
            session_id: `selftest-${process.pid}-${Date.now()}`,
            tool_input: { file_path: join(base, "packages/a/src/x.ts") },
            cwd: base,
        });
        const first = hookOutput(payload, { root: base });
        const ctx = first ? JSON.parse(first).hookSpecificOutput : null;
        ok(
            "hook returns PreToolUse additionalContext with the invariants",
            ctx?.hookEventName === "PreToolUse" && /\[a1\]/.test(ctx.additionalContext),
        );
        ok(
            "hook is silent the second time in a session",
            hookOutput(payload, { root: base }) === "",
        );
        ok(
            "hook re-sends once the resend window has passed",
            /\[a1\]/.test(hookOutput(payload, { root: base, resendMinutes: 0 })),
        );
        const cls = [
            ["npx vitest run packages/x", "broad"],
            ["npx tsc --noEmit --project packages/x/tsconfig.json", "broad"],
            ["npx eslint --config packages/x/eslint.config.mjs", "broad"],
            ["npm run build --prefix apps/x", "broad"],
            ["npx vitest run packages/x/src/a.test.ts", "targeted"],
            ["npm run check:money-units", "targeted"],
            ["node scripts/ok.mjs", "targeted"],
        ];
        ok(
            "classifyOracle separates targeted tests from whole-package runs",
            cls.every(([c, want]) => classifyOracle(c) === want),
            cls.map(([c]) => `${c} → ${classifyOracle(c)}`).join("; "),
        );
        ok("hook is silent on junk input", hookOutput("not json", { root: base }) === "");

        const probe = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `const m = await import(${JSON.stringify(pathToFileURL(LIB).href)}); console.log("IMPORTED " + Object.keys(m).length);`,
            ],
            { encoding: "utf8" },
        );
        const out = `${probe.stdout}${probe.stderr}`.trim();
        ok(
            "import-has-no-side-effects",
            probe.status === 0 && /^IMPORTED \d+$/.test(out),
            out.slice(0, 200),
        );
    } finally {
        for (const r of roots) rmSync(r, { recursive: true, force: true });
    }
    if (failed) {
        error(`selftest FAIL: ${passed} passed, ${failed} failed`);
        return false;
    }
    log(`selftest PASS: ${passed} checks`);
    return true;
}
