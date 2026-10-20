// Type definitions for the Agent-Native Context library (lib/index.mjs).

export type DependencyVia =
    | "import"
    | "rpc"
    | "db-realtime"
    | "db-query"
    | "event"
    | "file"
    | "cli";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type InvariantType = "data" | "process" | "security" | "integrity";

export interface ModuleSpec {
    name: string;
    package?: string | null;
    purpose: string;
    domain: string;
    path: string;
}

export interface DependencyRef {
    module: string;
    via: DependencyVia;
    risk?: RiskLevel;
}

export interface InvariantSpec {
    id: string;
    rule: string;
    type: InvariantType;
    enforced_by?: string[];
    /** Shell command run from the workspace root; exit 0 means the invariant holds. null = not mechanically checked. */
    test?: string | null;
}

export interface AuthoritySpec {
    autonomous?: string[];
    founder_approval?: string[];
    notes?: string | null;
}

export interface BlastRadiusSpec {
    level: RiskLevel;
    upstream?: string[];
    downstream?: string[];
    data_impact?: string;
}

/** A parsed CONTEXT.agent.yaml. The schema defines further optional sections (health, entities, active_work, …). */
export interface ContextAgentDoc {
    module: ModuleSpec;
    dependencies?: {
        reads_from?: DependencyRef[];
        writes_to?: DependencyRef[];
        shared_tables?: string[];
        last_verified?: string;
    };
    invariants?: InvariantSpec[];
    authority?: AuthoritySpec;
    blast_radius?: BlastRadiusSpec;
    [section: string]: unknown;
}

export interface ResolvedContext {
    /** Path relative to the workspace root. */
    file: string;
    abs: string;
    doc: ContextAgentDoc;
}

export interface WorkspacePackage {
    dir: string;
    dependencies: string[];
    devDependencies: string[];
    peerDependencies: string[];
    scripts: Record<string, string>;
}

export interface ValidationResult {
    path: string;
    abs: string;
    ok: boolean;
    doc?: ContextAgentDoc;
    errors?: string[];
}

export interface CheckResult {
    ok: boolean;
    failures: string[];
    /** Human-readable report lines. */
    lines: string[];
}

export interface Stats {
    contracts: number;
    invariants: number;
    invariants_with_test: number;
    invariants_without_test: number;
    /** Tests aimed at a specific file, script or check. */
    targeted_oracles: number;
    /** Tests that run a whole package's or directory's tests, a typecheck, a lint or a build. */
    broad_oracles: number;
    workspace_cycles: number;
}

export interface VerifyRun {
    command: string;
    invariants: string[];
    status: number | string;
    ms: number;
}

export const CONTEXT_FILE: "CONTEXT.agent.yaml";
export const BUNDLED_SCHEMA: string;
export const PLACEHOLDER_RULE: string;
export const PLACEHOLDER_PURPOSE_SUFFIX: string;
export const PLACEHOLDER_AUTHORITY: string;

export function parseYaml(text: string): unknown;
export function stringifyYaml(value: unknown): string;
export function shortName(name: string): string;

export function findWorkspaceRoot(startDir?: string): string;
export function findContextFiles(root: string): string[];
export function workspacePackages(root: string): Map<string, WorkspacePackage>;
export function findNearestContext(root: string, target: string): string | null;
export function findContextByName(root: string, name: string, files?: string[]): string | null;
export function resolveContext(root: string, target: string): ResolvedContext | null;

export function schemaPathFor(root: string): string;
export function compileSchema(schemaPath: string): (doc: unknown) => boolean;
export function validateContextFile(
    root: string,
    file: string,
    validate: (doc: unknown) => boolean,
): ValidationResult;

export function checkAuthority(results: ValidationResult[]): string[];
export function checkPlaceholders(results: ValidationResult[]): string[];
export function checkDependencyParity(
    root: string,
    results: ValidationResult[],
    packages?: Map<string, WorkspacePackage>,
): { failures: string[]; checked: number };
export function findWorkspaceCycles(packages: Map<string, WorkspacePackage>): string[][];
export function oracleProblems(
    root: string,
    command: string,
    packages?: Map<string, WorkspacePackage>,
): string[];
export function checkOracles(
    root: string,
    results: ValidationResult[],
    packages?: Map<string, WorkspacePackage>,
): { failures: string[]; commands: number };
export function check(root: string, options?: { schemaPath?: string }): CheckResult;

export function formatContext(res: ResolvedContext): string;
export function stats(root: string): Stats;
/** "targeted" when the test names a specific script/test file or a named npm script; otherwise "broad". */
export function classifyOracle(command: string): "targeted" | "broad";
export function verify(
    root: string,
    options?: {
        targets?: string[];
        all?: boolean;
        changed?: string | null;
        timeoutSec?: number;
        stdio?: "inherit" | "ignore" | "pipe";
        log?: (line: string) => void;
    },
): { runs: VerifyRun[]; failed: number; contracts: number };

export function scaffold(
    root: string,
    dir: string,
    packages?: Map<string, WorkspacePackage>,
): ContextAgentDoc;
export function writeScaffold(root: string, dir: string): string | null;

/** Claude Code PreToolUse: returns the hookSpecificOutput JSON string to print, or "" to stay silent. */
export function hookOutput(
    payload: string | object,
    options?: { root?: string | null; stateDir?: string; resendMinutes?: number },
): string;
