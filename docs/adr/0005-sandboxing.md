# ADR 0005: Sandboxing: Docker + gVisor (self-host), Firecracker microVMs (SaaS)

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

sandbox-runner executes untrusted customer code: builds, generated tests, Semgrep, SCIP indexers. Repo content may be malicious (build scripts, postinstall hooks). In SaaS, tenants share hosts; self-host customers run on standard Kubernetes or Docker hosts often without nested virtualization.

## Decision

- SaaS: Firecracker microVMs on bare-metal node pool; per-run VM from language base snapshot (snapshot restore for fast start); jailer, seccomp, cgroups; one VM per run, never reused across tenants.
- Self-host: Docker/containerd with gVisor runtime (runsc) via RuntimeClass; works without KVM.
- Both: no network by default (dependency fetch via allow-listed caching proxy in a pre-step only), read-only base image, ephemeral writable layer, CPU/mem/disk/pids/time limits, no credentials or tokens mounted, outputs returned via object store with tenant prefix.
- sandbox-runner exposes one interface (SandboxDriver) with two implementations.

## Alternatives considered

- **Plain Docker / runc**: shared kernel, insufficient for hostile code in multi-tenant SaaS.
- **Kata Containers**: VM isolation with k8s integration; heavier and more complex than Firecracker for our short-lived runs; viable self-host option later.
- **gVisor everywhere**: simpler single path, but syscall overhead hurts build-heavy workloads and isolation is weaker than hardware virtualization for SaaS.
- **Managed sandboxes (e.g. E2B)**: fast to adopt, but third-party data processing and unavailable air-gapped.
- **WASM sandboxes**: cannot run arbitrary toolchains.

## Consequences

- Positive: strong isolation in SaaS, deployable isolation in self-host.
- Negative: two drivers to maintain and test; Firecracker requires bare metal or nested-virt instances; gVisor has compatibility gaps for some syscalls/toolchains (maintain known-incompatible list, fall back to skipping execution, never to runc).
- Requires external pentest before Phase 3 exit.
