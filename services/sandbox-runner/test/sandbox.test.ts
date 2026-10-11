import { expect, test } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirecrackerDriver, GVisorDriver, MockSandboxDriver, SandboxSpecError, SandboxUnavailableError, selectDriver, validateSpec, type ExecPort, type FirecrackerLaunch } from "../src/sandbox.ts";

const base = { image: "node:24", command: ["node", "-e", "1"] };

test("mock driver flags timeouts and truncates output", async () => {
  const d = new MockSandboxDriver((s, i) => (i === 0 ? { durationMs: s.limits.timeoutSec * 1000 + 1 } : { stdout: "x".repeat(100), stderr: "e" }));
  const t = await d.run({ ...base, limits: { timeoutSec: 2 } });
  expect(t).toMatchObject({ timedOut: true, exitCode: 124 });
  const r = await d.run({ ...base, outputCapBytes: 10 });
  expect(r.timedOut).toBe(false);
  expect(r.stdout.startsWith("x".repeat(10) + "\n[truncated 90 bytes]")).toBe(true);
  expect(r.stderr).toBe("e");
  expect(d.calls[1]!.limits.network).toBe("none");
});

test.each([
  ["egress without proxy network", { limits: { network: "egress-allowlist" as const } }],
  ["secret env", { env: { GITHUB_TOKEN: "x" } }],
  ["api key env", { env: { OPENAI_API_KEY: "x" } }],
  ["password env", { env: { db_password: "x" } }],
  ["timeout > 3600", { limits: { timeoutSec: 3601 } }],
  ["memory cap", { limits: { memoryMb: 65536 } }],
  ["cpu cap", { limits: { cpus: 64 } }],
  ["file traversal", { files: { "../etc/passwd": "x" } }],
  ["host mount outside workspace", { workspaceDir: "/etc" }],
  ["output outside /out", { outputs: ["/etc/shadow"] }],
])("validateSpec rejects %s", async (_n, extra) => {
  expect(() => validateSpec({ ...base, ...extra }, join(tmpdir(), "ws-root"))).toThrow(SandboxSpecError);
  await expect(new MockSandboxDriver().run({ ...base, ...extra })).rejects.toThrow(SandboxSpecError);
});

test("validateSpec accepts workspace under root and allow-listed env", () => {
  const v = validateSpec({ ...base, env: { CI: "1", NODE_ENV: "test" }, workspaceDir: "/srv/ws/run1" }, "/srv/ws");
  expect(v.limits).toEqual({ cpus: 1, memoryMb: 1024, timeoutSec: 300, pids: 256, network: "none" });
});

function recordingExec(result = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const exec: ExecPort = async (file, args, opts) => { calls.push({ file, args, timeoutMs: opts.timeoutMs }); return result; };
  return { calls, exec };
}

test("gVisor argv: runsc, network none, limits, hardening, no shell", async () => {
  const { calls, exec } = recordingExec();
  const r = await new GVisorDriver({ exec }).run({ ...base, env: { CI: "1" }, limits: { cpus: 2, memoryMb: 512, pids: 64, timeoutSec: 30 } });
  expect(r.exitCode).toBe(0);
  const { file, args, timeoutMs } = calls[0]!;
  expect(file).toBe("docker");
  expect(timeoutMs).toBe(30_000);
  const norm = args.map((a) => a.replace(/^.*sbx-[^/]+\/(ws|out):/, "<$1>:"));
  expect(norm).toMatchInlineSnapshot(`
    [
      "run",
      "--rm",
      "--runtime=runsc",
      "--network=none",
      "--cpus=2",
      "--memory=512m",
      "--memory-swap=512m",
      "--pids-limit=64",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "-u",
      "65534:65534",
      "-v",
      "<ws>:/workspace",
      "-v",
      "<out>:/out",
      "-w",
      "/workspace",
      "-e",
      "CI=1",
      "--",
      "node:24",
      "node",
      "-e",
      "1",
    ]
  `);
  expect(args.some((a) => /^(sh|bash|-c)$/.test(a))).toBe(false);
});

test("gVisor egress-allowlist maps to the named proxy network", async () => {
  const { calls, exec } = recordingExec();
  await new GVisorDriver({ exec }).run({ ...base, limits: { network: "egress-allowlist" }, egressNetwork: "sandbox-egress" });
  expect(calls[0]!.args).toContain("--network=sandbox-egress");
});

test("gVisor never falls back to runc when runsc is missing", async () => {
  const { calls, exec } = recordingExec({ exitCode: 125, stdout: "", stderr: "docker: Error response from daemon: unknown or invalid runtime name: runsc.", timedOut: false });
  await expect(new GVisorDriver({ exec }).run(base)).rejects.toBeInstanceOf(SandboxUnavailableError);
  expect(calls).toHaveLength(1);
  const enoent: ExecPort = async () => { throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }); };
  await expect(new GVisorDriver({ exec: enoent }).run(base)).rejects.toBeInstanceOf(SandboxUnavailableError);
});

test("firecracker config: no network iface by default, vcpu/mem mapping, jailer args", async () => {
  const launches: FirecrackerLaunch[] = [];
  const d = new FirecrackerDriver({ kernelPath: "/k/vmlinux", rootfsSnapshot: "/snap/rootfs.ext4", launcher: async (l) => { launches.push(l); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; } });
  await d.run({ ...base, limits: { cpus: 1.5, memoryMb: 2048 } });
  const c = launches[0]!.config;
  expect(c["network-interfaces"]).toEqual([]);
  expect(c["machine-config"]).toEqual({ vcpu_count: 2, mem_size_mib: 2048, smt: false });
  expect(c.drives[0]).toMatchObject({ path_on_host: "/snap/rootfs.ext4", is_root_device: true, is_read_only: true });
  expect(c["boot-source"].kernel_image_path).toBe("/k/vmlinux");
  expect(launches[0]!.jailerArgs).toEqual(expect.arrayContaining(["--uid", "65534", "--new-pid-ns", "--no-api"]));
  await d.run({ ...base, limits: { network: "egress-allowlist" }, egressNetwork: "proxy" });
  expect(launches[1]!.config["network-interfaces"]).toHaveLength(1);
});

test("selectDriver", () => {
  expect(selectDriver({ SANDBOX_DRIVER: "mock" }).name).toBe("mock");
  expect(selectDriver({ RUNTIME_MODE: "memory" }).name).toBe("mock");
  expect(selectDriver({}).name).toBe("gvisor");
  expect(() => selectDriver({ SANDBOX_DRIVER: "firecracker" })).toThrow(SandboxUnavailableError);
  expect(() => selectDriver({ SANDBOX_DRIVER: "runc" })).toThrow(SandboxSpecError);
});
