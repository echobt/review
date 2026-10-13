import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { SandboxLimits } from "@review/core";

export interface SandboxSpec {
  image: string;
  command: string[];
  /** Workspace contents keyed by relative path (mounted at /workspace). */
  files?: Record<string, string | Buffer>;
  /** Host workspace dir; must live under the sandbox workspace root. */
  workspaceDir?: string;
  /** Allow-listed env only. Names that look like secrets are rejected. */
  env?: Record<string, string>;
  limits?: Partial<SandboxLimits>;
  /** Named proxy network used when limits.network = "egress-allowlist". */
  egressNetwork?: string;
  /** Absolute in-sandbox paths (under /workspace or /out) to return in result.files. */
  outputs?: string[];
  /** Max bytes kept per stream (default 64 KiB). */
  outputCapBytes?: number;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  files?: Record<string, Buffer>;
}

export interface SandboxDriver {
  readonly name: string;
  run(spec: SandboxSpec): Promise<SandboxResult>;
}

export class SandboxUnavailableError extends Error {
  readonly driver: string;
  constructor(driver: string, message: string) { super(message); this.name = "SandboxUnavailableError"; this.driver = driver; }
}
export class SandboxSpecError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxSpecError"; }
}

export const SECRET_ENV = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
export const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_CAP = 64 * 1024;

export interface ValidSpec extends SandboxSpec { limits: SandboxLimits; env: Record<string, string>; outputCapBytes: number }

const safeRel = (p: string) => !isAbsolute(p) && !normalize(p).split(/[\\/]/).includes("..");

/** Shared invariants for every driver. Throws SandboxSpecError. */
export function validateSpec(spec: SandboxSpec, workspaceRoot = process.env.SANDBOX_WORKSPACE_ROOT ?? tmpdir()): ValidSpec {
  if (!spec.image.trim()) throw new SandboxSpecError("image required");
  if (spec.command.length === 0) throw new SandboxSpecError("command required");
  const parsed = SandboxLimits.safeParse(spec.limits ?? {});
  if (!parsed.success) throw new SandboxSpecError(`invalid limits: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const limits = parsed.data;
  if (limits.timeoutSec > MAX_TIMEOUT_SEC) throw new SandboxSpecError("timeout exceeds 3600s");
  if (limits.network === "egress-allowlist" && !/^[a-z0-9][a-z0-9_.-]*$/i.test(spec.egressNetwork ?? "")) {
    throw new SandboxSpecError("egress-allowlist requires a named proxy network");
  }
  if (limits.network === "none" && spec.egressNetwork) throw new SandboxSpecError("egressNetwork given while network is none");
  const env = spec.env ?? {};
  for (const k of Object.keys(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) throw new SandboxSpecError(`invalid env name ${k}`);
    if (SECRET_ENV.test(k)) throw new SandboxSpecError(`env var ${k} looks like a secret`);
  }
  for (const p of Object.keys(spec.files ?? {})) if (!safeRel(p)) throw new SandboxSpecError(`file path escapes workspace: ${p}`);
  if (spec.workspaceDir !== undefined) {
    const rel = relative(resolve(workspaceRoot), resolve(spec.workspaceDir));
    if (!isAbsolute(spec.workspaceDir) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new SandboxSpecError("workspaceDir outside sandbox workspace root");
  }
  for (const o of spec.outputs ?? []) {
    if (!/^\/(workspace|out)\//.test(o) || !safeRel(o.replace(/^\/(workspace|out)\//, ""))) throw new SandboxSpecError(`output path not allowed: ${o}`);
  }
  return { ...spec, limits, env, outputCapBytes: spec.outputCapBytes ?? DEFAULT_CAP };
}

export function truncate(s: string, cap: number): string {
  const b = Buffer.from(s);
  return b.length <= cap ? s : `${b.subarray(0, cap).toString()}\n[truncated ${b.length - cap} bytes]`;
}

// ---------- exec port ----------
export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
export type ExecPort = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

/** execFile, never a shell. Spawn failures (ENOENT) reject; non-zero exits resolve. */
export const nodeExec: ExecPort = (file, args, opts) => new Promise((res, rej) => {
  execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
    if (e && typeof e.code === "string") return rej(e);
    res({ exitCode: e ? (typeof e.code === "number" ? e.code : 137) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
  });
});

async function materialize(spec: ValidSpec): Promise<{ ws: string; out: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "sbx-"));
  const ws = spec.workspaceDir ?? join(base, "ws");
  const out = join(base, "out");
  await mkdir(out, { recursive: true });
  for (const [p, c] of Object.entries(spec.files ?? {})) {
    const f = join(ws, p);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, c);
  }
  await mkdir(ws, { recursive: true });
  return { ws, out, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function collect(spec: ValidSpec, ws: string, out: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const o of spec.outputs ?? []) {
    const host = o.startsWith("/out/") ? join(out, o.slice(5)) : join(ws, o.slice(11));
    try { files[o] = await readFile(host); } catch { /* missing output is reported by absence */ }
  }
  return files;
}

// ---------- gVisor ----------
export function gvisorArgv(spec: ValidSpec, ws: string, out: string): string[] {
  const l = spec.limits;
  return [
    "run", "--rm", "--runtime=runsc",
    `--network=${l.network === "none" ? "none" : spec.egressNetwork}`,
    `--cpus=${l.cpus}`, `--memory=${l.memoryMb}m`, `--memory-swap=${l.memoryMb}m`, `--pids-limit=${l.pids}`,
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "-u", "65534:65534",
    "-v", `${ws}:/workspace`, "-v", `${out}:/out`, "-w", "/workspace",
    ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--", spec.image, ...spec.command,
  ];
}

const RUNSC_MISSING = /unknown or invalid runtime name: runsc|runtime "runsc" not found/i;

export class GVisorDriver implements SandboxDriver {
  readonly name = "gvisor";
  readonly #exec: ExecPort;
  readonly #docker: string;
  constructor(deps: { exec?: ExecPort; docker?: string } = {}) { this.#exec = deps.exec ?? nodeExec; this.#docker = deps.docker ?? "docker"; }

  async run(input: SandboxSpec): Promise<SandboxResult> {
    const spec = validateSpec(input);
    const { ws, out, cleanup } = await materialize(spec);
    const t0 = Date.now();
    try {
      let r: ExecResult;
      try { r = await this.#exec(this.#docker, gvisorArgv(spec, ws, out), { timeoutMs: spec.limits.timeoutSec * 1000 }); } catch (e) {
        throw new SandboxUnavailableError(this.name, `docker unavailable: ${(e as Error).message}`);
      }
      // Never fall back to runc: a missing runsc runtime is fatal for this driver.
      if (r.exitCode === 125 && RUNSC_MISSING.test(r.stderr)) throw new SandboxUnavailableError(this.name, "runsc runtime not installed");
      return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: truncate(r.stdout, spec.outputCapBytes), stderr: truncate(r.stderr, spec.outputCapBytes),
        timedOut: r.timedOut, durationMs: Date.now() - t0, files: await collect(spec, ws, out) };
    } finally { await cleanup(); }
  }
}

// ---------- Firecracker ----------
export interface FirecrackerVmConfig {
  "boot-source": { kernel_image_path: string; boot_args: string };
  drives: { drive_id: string; path_on_host: string; is_root_device: boolean; is_read_only: boolean }[];
  "machine-config": { vcpu_count: number; mem_size_mib: number; smt: false };
  "network-interfaces": { iface_id: string; host_dev_name: string }[];
}
export interface FirecrackerLaunch { config: FirecrackerVmConfig; jailerArgs: string[]; spec: ValidSpec }
export type FirecrackerLauncher = (l: FirecrackerLaunch) => Promise<ExecResult & { files?: Record<string, Buffer> }>;

export interface FirecrackerOptions { kernelPath: string; rootfsSnapshot: string; jailerUid?: number; jailerGid?: number; chrootBase?: string; launcher: FirecrackerLauncher }

export function firecrackerConfig(spec: ValidSpec, o: Pick<FirecrackerOptions, "kernelPath" | "rootfsSnapshot">): FirecrackerVmConfig {
  return {
    "boot-source": { kernel_image_path: o.kernelPath, boot_args: "console=ttyS0 reboot=k panic=1 pci=off ro" },
    // Read-only snapshot rootfs; the launcher attaches the workspace as a scratch drive built from spec.files.
    drives: [{ drive_id: "rootfs", path_on_host: o.rootfsSnapshot, is_root_device: true, is_read_only: true }],
    "machine-config": { vcpu_count: Math.max(1, Math.ceil(spec.limits.cpus)), mem_size_mib: spec.limits.memoryMb, smt: false },
    "network-interfaces": spec.limits.network === "none" ? [] : [{ iface_id: "eth0", host_dev_name: `tap-${spec.egressNetwork}` }],
  };
}

export class FirecrackerDriver implements SandboxDriver {
  readonly name = "firecracker";
  readonly #o: FirecrackerOptions;
  constructor(o: FirecrackerOptions) { this.#o = o; }

  jailerArgs(id: string): string[] {
    return ["--id", id, "--exec-file", "/usr/bin/firecracker", "--uid", String(this.#o.jailerUid ?? 65534), "--gid", String(this.#o.jailerGid ?? 65534),
      "--chroot-base-dir", this.#o.chrootBase ?? "/srv/jailer", "--new-pid-ns", "--", "--config-file", "vm.json", "--no-api"];
  }

  async run(input: SandboxSpec): Promise<SandboxResult> {
    const spec = validateSpec(input);
    const t0 = Date.now();
    let r: Awaited<ReturnType<FirecrackerLauncher>>;
    try { r = await this.#o.launcher({ config: firecrackerConfig(spec, this.#o), jailerArgs: this.jailerArgs(`sbx-${t0.toString(36)}`), spec }); } catch (e) {
      throw new SandboxUnavailableError(this.name, `firecracker launch failed: ${(e as Error).message}`);
    }
    return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: truncate(r.stdout, spec.outputCapBytes), stderr: truncate(r.stderr, spec.outputCapBytes),
      timedOut: r.timedOut, durationMs: Date.now() - t0, ...(r.files ? { files: r.files } : {}) };
  }
}

// ---------- Mock ----------
export type MockHandler = (spec: ValidSpec, call: number) => Partial<SandboxResult> | Promise<Partial<SandboxResult>>;

/** In-process scripted driver. A handler-reported durationMs above the timeout is flagged as timedOut (no real waiting). */
export class MockSandboxDriver implements SandboxDriver {
  readonly name = "mock";
  readonly calls: ValidSpec[] = [];
  readonly #handler: MockHandler;
  constructor(handler: MockHandler = () => ({})) { this.#handler = handler; }

  async run(input: SandboxSpec): Promise<SandboxResult> {
    const spec = validateSpec(input);
    this.calls.push(spec);
    const r = await this.#handler(spec, this.calls.length - 1);
    const durationMs = r.durationMs ?? 0;
    const timedOut = r.timedOut === true || durationMs > spec.limits.timeoutSec * 1000;
    return { exitCode: timedOut ? 124 : r.exitCode ?? 0, stdout: truncate(r.stdout ?? "", spec.outputCapBytes), stderr: truncate(r.stderr ?? "", spec.outputCapBytes),
      timedOut, durationMs, ...(r.files ? { files: r.files } : {}) };
  }
}

/** SANDBOX_DRIVER=gvisor|firecracker|mock (default gvisor; memory runtime defaults to mock). */
export function selectDriver(env: NodeJS.ProcessEnv = process.env, deps: { exec?: ExecPort; launcher?: FirecrackerLauncher; mock?: MockHandler } = {}): SandboxDriver {
  const kind = env.SANDBOX_DRIVER ?? (env.RUNTIME_MODE === "memory" ? "mock" : "gvisor");
  if (kind === "gvisor") return new GVisorDriver({ ...(deps.exec ? { exec: deps.exec } : {}), ...(env.DOCKER_BIN ? { docker: env.DOCKER_BIN } : {}) });
  if (kind === "mock") return new MockSandboxDriver(deps.mock);
  if (kind === "firecracker") {
    if (!deps.launcher || !env.FIRECRACKER_KERNEL || !env.FIRECRACKER_ROOTFS) throw new SandboxUnavailableError("firecracker", "firecracker launcher/kernel/rootfs not configured");
    return new FirecrackerDriver({ kernelPath: env.FIRECRACKER_KERNEL, rootfsSnapshot: env.FIRECRACKER_ROOTFS, launcher: deps.launcher });
  }
  throw new SandboxSpecError(`unknown SANDBOX_DRIVER ${kind}`);
}
