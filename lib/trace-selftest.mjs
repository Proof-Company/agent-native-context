// ═══════════════════════════════════════════════════════════════════════════
// ANC Trace Selftest — verifies code topology, runtime detection,
// component resolution, wire extraction, and planted failure cases.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookOutput } from "./index.mjs";
import {
    detectRuntime,
    extractImportMap,
    extractRenderedComponents,
    extractWires,
    formatTrace,
    traceBatch,
    traceFile,
} from "./trace.mjs";

export function selftestTrace() {
    let passed = 0;
    const test = (name, fn) => {
        try {
            fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (err) {
            console.error(`  ✗ ${name}`);
            throw err;
        }
    };

    console.log("ANC trace selftest");

    // 1. Runtime detection
    test("detects client-component via directive", () => {
        const code = `"use client";\nimport React from "react";\nexport default function Comp() {}`;
        assert.strictEqual(detectRuntime(code, "features/comp.tsx"), "client-component");
    });

    test("detects server-action via directive", () => {
        const code = `"use server";\nexport async function action() {}`;
        assert.strictEqual(detectRuntime(code, "actions/save.ts"), "server-action");
    });

    test("detects route-handler via path and exports", () => {
        const code = `export async function GET(req) { return Response.json({}); }`;
        assert.strictEqual(detectRuntime(code, "apps/erp/app/api/jobs/route.ts"), "route-handler");
    });

    test("detects background-worker via inngest", () => {
        const code = `import { inngest } from "./client";\nexport default inngest.createFunction({}, { event: "job.sync" });`;
        assert.strictEqual(detectRuntime(code, "inngest/functions.ts"), "background-worker");
    });

    test("detects server-component in Next app router", () => {
        const code = `export default function Page() { return <div>Server</div>; }`;
        assert.strictEqual(detectRuntime(code, "apps/erp/app/jobs/page.tsx"), "server-component");
    });

    test("detects test-suite", () => {
        const code = `describe("test", () => {});`;
        assert.strictEqual(
            detectRuntime(code, "packages/spatial/__tests__/queue.test.ts"),
            "test-suite",
        );
    });

    test("detects library-module", () => {
        const code = `export function add(a, b) { return a + b; }`;
        assert.strictEqual(detectRuntime(code, "packages/utils/src/math.ts"), "library-module");
    });

    // 2. Rendered components extraction
    test("extracts rendered JSX components and pairs with imports", () => {
        const code = `
            import Header from "./Header";
            import { Button as PrimaryButton } from "@proof/ui";
            export default function View() {
                return (
                    <div className="container">
                        <Header title="Test" />
                        <PrimaryButton onClick={() => {}}>Save</PrimaryButton>
                        <CustomBadge count={5} />
                    </div>
                );
            }
        `;
        const importMap = extractImportMap(code);
        const rendered = extractRenderedComponents(code, importMap);
        assert.deepStrictEqual(rendered, [
            "CustomBadge",
            "Header (from ./Header)",
            "PrimaryButton (from @proof/ui)",
        ]);
    });

    test("filters out standard HTML and SVG tags", () => {
        const code = `
            export default function Render() {
                return (
                    <section>
                        <h1>Title</h1>
                        <svg><path d="M0 0" /></svg>
                        <button><span /></button>
                    </section>
                );
            }
        `;
        const rendered = extractRenderedComponents(code, new Map());
        assert.deepStrictEqual(rendered, []);
    });

    // 3. Wire extraction: APIs, DB tables, Events, Hooks
    test("extracts outbound API fetches including template literals", () => {
        const code = `
            fetch("/api/v1/jobs");
            useAuthenticatedQuery(["orders"], \`/api/jobs/\${jobId}/change-orders\`);
        `;
        const wires = extractWires(code, "comp.tsx");
        assert(wires.apis.includes("FETCH: /api/v1/jobs"));
        assert(
            wires.apis.some(
                (a) => a.startsWith("FETCH: /api/jobs/") && a.endsWith("/change-orders"),
            ),
        );
    });

    test("extracts inbound route methods for API route handlers", () => {
        const code = `
            export async function GET(req) {}
            export const POST = createRoute({});
        `;
        const wires = extractWires(code, "apps/erp/app/api/admin/billing/route.ts");
        assert(wires.apis.includes("INBOUND: [GET, POST] /api/admin/billing"));
    });

    test("distinguishes database tables from Buffer.from, Array.from, and storage.from", () => {
        const code = `
            const buf = Buffer.from(raw, "hex");
            const arr = Array.from({ length: 5 });
            const s = await db.storage.from("photos").download(path);
            const { data } = await supabase.from("job_phases").select("*").eq("tenant_id", tenantId);
            const { error } = await db.from("invoices").insert({});
        `;
        const wires = extractWires(code, "service.ts");
        const tableNames = wires.tables.map((t) => t.table);
        assert(!tableNames.includes("raw"));
        assert(!tableNames.includes("length"));
        assert(!tableNames.includes("photos"));
        assert.deepStrictEqual(tableNames, ["invoices", "job_phases"]);
        assert.strictEqual(wires.tables[0].tenant_scoped, true);
    });

    test("flags WARN when database query lacks tenant scoping", () => {
        const code = `
            const { data } = await supabase.from("unprotected_table").select("*");
        `;
        const wires = extractWires(code, "unsafe.ts");
        assert.strictEqual(wires.tables[0].table, "unprotected_table");
        assert(String(wires.tables[0].tenant_scoped).startsWith("WARN"));
    });

    test("extracts inngest events emitted and listened", () => {
        const code = `
            await inngest.send({ name: "job.dispatched", data: { id: 1 } });
            export const fn = inngest.createFunction({ id: "handler" }, { event: "carrier.received" });
        `;
        const wires = extractWires(code, "inngest/worker.ts");
        assert(wires.events.includes("EMIT: job.dispatched"));
        assert(wires.events.includes("LISTEN: carrier.received"));
    });

    test("extracts domain hooks while excluding React primitives", () => {
        const code = `
            const [val, setVal] = useState(0);
            useEffect(() => {}, []);
            const { job } = useHomeownerState();
            const { track } = usePortalAnalytics(123);
        `;
        const wires = extractWires(code, "view.tsx");
        assert.deepStrictEqual(wires.hooks, ["useHomeownerState", "usePortalAnalytics"]);
    });

    // 4. End-to-end trace with throwaway workspace & ANC contract coupling
    test("traceFile resolves nearest CONTEXT.agent.yaml and couples invariants", () => {
        const tmp = mkdtempSync(join(tmpdir(), "anc-trace-"));
        try {
            mkdirSync(join(tmp, "packages", "test-pkg"), { recursive: true });
            writeFileSync(
                join(tmp, "package.json"),
                JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
            );
            writeFileSync(
                join(tmp, "packages", "test-pkg", "CONTEXT.agent.yaml"),
                `
module:
  name: test-pkg
  purpose: Fixture package for trace
invariants:
  - id: inv-01
    rule: Strict money cents invariant
    type: data
authority:
  founder_approval:
    - Modify core money calculation
blast_radius:
  level: high
  data_impact: Breaks downstream calculations
`,
            );
            writeFileSync(
                join(tmp, "packages", "test-pkg", "Component.tsx"),
                `
"use client";
import React from "react";
import Child from "./Child";
import { useSpecialHook } from "@/hooks";
export default function Component() {
    useSpecialHook();
    return <Child />;
}
`,
            );

            const result = traceFile(tmp, "packages/test-pkg/Component.tsx");
            assert.strictEqual(result.runtime, "client-component");
            assert.strictEqual(result.module, "test-pkg");
            assert.strictEqual(result.purpose, "Fixture package for trace");
            assert.deepStrictEqual(result.renders, ["Child (from ./Child)"]);
            assert.deepStrictEqual(result.wires.hooks, ["useSpecialHook"]);
            assert.strictEqual(result.invariants.length, 1);
            assert.strictEqual(result.invariants[0].id, "inv-01");
            assert.strictEqual(
                result.authority.founder_approval[0],
                "Modify core money calculation",
            );
            assert.strictEqual(result.blast_radius.level, "high");

            // Verify formatTrace output
            const formatted = formatTrace(result);
            assert(formatted.includes("runtime: client-component"));
            assert(formatted.includes("module: test-pkg"));
            assert(formatted.includes("inv-01"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    // 5. Transitive wires with depth > 0
    test("traceFile extracts transitive wires from local relative imports when depth > 0", () => {
        const tmp = mkdtempSync(join(tmpdir(), "anc-trace-trans-"));
        try {
            mkdirSync(join(tmp, "src"), { recursive: true });
            writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "trans-test" }));
            writeFileSync(
                join(tmp, "src", "helper.ts"),
                `export function queryHelper() { fetch("/api/v1/helper"); }`,
            );
            writeFileSync(
                join(tmp, "src", "Main.tsx"),
                `import { queryHelper } from "./helper";\nexport default function Main() { return null; }`,
            );

            const direct = traceFile(tmp, "src/Main.tsx", { depth: 0 });
            assert.strictEqual(direct.transitive_wires, null);

            const transitive = traceFile(tmp, "src/Main.tsx", { depth: 1 });
            assert(transitive.transitive_wires !== null);
            assert(transitive.transitive_wires.apis.some((a) => a.includes("/api/v1/helper")));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    // 6. Batch directory tracing
    test("traceBatch summarizes architecture across a directory", () => {
        const tmp = mkdtempSync(join(tmpdir(), "anc-trace-batch-"));
        try {
            mkdirSync(join(tmp, "routes"), { recursive: true });
            writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "batch-test" }));
            writeFileSync(join(tmp, "routes", "route.ts"), `export async function GET() {}`);
            writeFileSync(
                join(tmp, "routes", "view.tsx"),
                `"use client";\nexport default function V() {}`,
            );

            const batch = traceBatch(tmp, "routes");
            assert.strictEqual(batch.total_files_scanned, 2);
            assert.strictEqual(batch.runtimes["route-handler"], 1);
            assert.strictEqual(batch.runtimes["client-component"], 1);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    // 7. Hook integration with trace
    test("hookOutput attaches code topology & wire trace when editing source file", () => {
        const tmp = mkdtempSync(join(tmpdir(), "anc-trace-hook-"));
        try {
            mkdirSync(join(tmp, "src"), { recursive: true });
            writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "hook-test" }));
            writeFileSync(
                join(tmp, "CONTEXT.agent.yaml"),
                `module:\n  name: hook-test\n  package: hook-test\n  purpose: Hook test\n  domain: platform\n  path: .\ndependencies:\n  reads_from: []\n  writes_to: []\ninvariants:\n  - id: h1\n    rule: Hook rule\n    type: data\n    test: null\nauthority:\n  autonomous: [edit]\n  founder_approval: [delete]\nblast_radius:\n  level: low\n`,
            );
            const targetFile = join(tmp, "src", "Widget.tsx");
            writeFileSync(
                targetFile,
                `"use client";\nimport { Header } from "./Header";\nexport function Widget() {\n  return <div><Header /></div>;\n}\n`,
            );

            const payload = JSON.stringify({
                session_id: `selftest-trace-hook-${Date.now()}`,
                tool_input: { file_path: targetFile },
                cwd: tmp,
            });

            const out = hookOutput(payload, { root: tmp });
            const parsed = JSON.parse(out);
            assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
            assert.ok(parsed.hookSpecificOutput.additionalContext.includes("[h1]"));
            assert.ok(
                parsed.hookSpecificOutput.additionalContext.includes("Code Topology & Wire Trace"),
            );
            assert.ok(parsed.hookSpecificOutput.additionalContext.includes("client-component"));
            assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Header"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    // 8. Planted negative cases
    test("plant: missing target file throws clean error", () => {
        assert.throws(
            () => traceFile(process.cwd(), "non_existent_file_xyz.tsx"),
            /Target file not found/,
        );
    });

    test("plant: target directory throws clean error", () => {
        assert.throws(() => traceFile(process.cwd(), "."), /Target is not a file/);
    });

    console.log(`trace selftest PASS: ${passed} checks`);
    return true;
}

if (process.argv[1]?.endsWith("trace-selftest.mjs")) {
    selftestTrace();
}
