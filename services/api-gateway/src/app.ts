import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  CreateFeedbackRequest, CreateIndexRequest, CreateReviewRequest, CreateTestGenRequest, ScoreRequest, TenantConfig, routes,
  type Message, type QueueName, type RepoIndex, type Review, type ReviewEvent, type ScoreJob, type TestGenRun,
} from "@review/core";
import {
  addFeedback, createIndexRecord, createReview, createScoreJob, createTestGenRecord, getIndexRecord, getReview, getScoreJob,
  getTenantConfig, getTestGenRecord, listFindings, putTenantConfig, withTenant, type Database, type Sql,
} from "@review/db";
import { tenantKey } from "@review/queue";
import { withSpan } from "@review/telemetry";
import type { ObjectStore } from "@review/service-common";

/** Port for enqueueing; real impl = BullMQ producers, tests = in-memory. jobId makes the enqueue idempotent. */
export type Enqueue = <Q extends QueueName>(queue: Q, tenantId: string, payload: Message<Q>["payload"], opts?: { jobId?: string }) => Promise<void>;
/** Resolves a bearer API key to a tenant id (real impl: hashed key lookup in api_keys). */
export type Authenticate = (apiKey: string) => Promise<string | undefined>;
/** GitHub App installation id -> tenant id. */
export type ResolveInstallation = (installationId: string) => Promise<string | undefined>;
/** In-process bus: main.ts feeds it from evt.* queues; payload is { tenantId, event }. */
export const REVIEW_EVENT = "review-event";
export interface BusEvent { tenantId: string; event: ReviewEvent }

export interface AppDeps {
  enqueue: Enqueue;
  authenticate: Authenticate;
  db?: Database;
  store?: ObjectStore;
  webhookSecret?: () => string | undefined;
  resolveInstallation?: ResolveInstallation;
  events?: EventEmitter;
  ready?: () => Promise<boolean>;
}

const EMBED_MODEL = "openai/text-embedding-3-small";
const RUBRIC_VERSION = "1.0.0";
const PUBLIC = new Set<string>([routes.health.path, "/readyz", routes.githubWebhook.path]);

/** Deterministic review id for a PR head: webhook redeliveries map to the same review and job. */
export const prReviewId = (repo: string, pr: number, headSha: string) => createHash("sha256").update(`${repo}#${pr}@${headSha}`).digest("hex").slice(0, 32);

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
  const got = Buffer.from(header.slice(7), "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  const err = (code: string, message: string) => ({ error: { code, message } });
  // ponytail: memory-mode state lives in this process only (RUNTIME_MODE=memory smoke runs); Postgres is the real store.
  const mem = { reviews: new Map<string, Review>(), configs: new Map<string, TenantConfig>(), scores: new Map<string, ScoreJob>(), indexes: new Map<string, RepoIndex>(), testgen: new Map<string, TestGenRun>() };
  const memKey = (t: string, id: string) => `${t}/${id}`;
  const tx = <T>(tenantId: string, fn: (sql: Sql) => Promise<T>) => withTenant(deps.db!, tenantId, fn);

  app.addHook("onRoute", (r) => {
    const h = r.handler as (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) => unknown;
    r.handler = function (req, reply) {
      return withSpan(`${r.method} ${r.url}`, { "http.request.method": String(r.method), "http.route": r.url ?? "", "request.id": req.id }, async () => h.call(this, req, reply));
    };
  });
  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id); });

  app.get(routes.health.path, async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    const ok = deps.ready ? await deps.ready().catch(() => false) : true;
    return reply.code(ok ? 200 : 503).send({ ok });
  });

  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC.has(req.routeOptions.url ?? "")) return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const tenantId = m ? await deps.authenticate(m[1]!) : undefined;
    if (!tenantId) return reply.code(401).send(err("unauthorized", "missing or invalid API key"));
    (req as unknown as { tenantId: string }).tenantId = tenantId;
  });
  const tenant = (req: unknown) => (req as { tenantId: string }).tenantId;
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  async function startReview(tenantId: string, r: { id: string; repositoryId: string; pullRequest?: Review["pullRequest"]; diff?: string }): Promise<Review> {
    const diffObjectKey = r.diff !== undefined ? tenantKey(tenantId, "diffs", `${r.id}.patch`) : undefined;
    if (diffObjectKey && deps.store) await deps.store.put(diffObjectKey, Buffer.from(r.diff!, "utf8"));
    const input = { id: r.id, repositoryId: r.repositoryId, ...(r.pullRequest ? { pullRequest: r.pullRequest } : {}), ...(diffObjectKey ? { diffObjectKey } : {}) };
    let review: Review;
    if (deps.db) review = await tx(tenantId, async (sql) => (await getReview(sql, r.id)) ?? createReview(sql, tenantId, input));
    else {
      review = mem.reviews.get(memKey(tenantId, r.id)) ?? { id: r.id, tenantId, repositoryId: r.repositoryId, status: "queued", findings: [], createdAt: new Date().toISOString(), ...(r.pullRequest ? { pullRequest: r.pullRequest } : {}) };
      mem.reviews.set(memKey(tenantId, r.id), review);
    }
    await deps.enqueue("review.requested", tenantId, { reviewId: r.id, repositoryId: r.repositoryId, ...(r.pullRequest ? { pullRequest: r.pullRequest } : {}), ...(diffObjectKey ? { diffObjectKey } : {}) }, { jobId: r.id });
    return review;
  }

  // ---------- GitHub webhook (raw body needed for HMAC) ----------
  app.register(async (gh) => {
    gh.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    gh.post(routes.githubWebhook.path, async (req, reply) => {
      const secret = deps.webhookSecret?.();
      if (!secret) return reply.code(503).send(err("not_configured", "webhook secret not configured"));
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifySignature(secret, raw, req.headers["x-hub-signature-256"] as string | undefined)) return reply.code(401).send(err("unauthorized", "invalid signature"));
      const event = req.headers["x-github-event"];
      if (event === "ping") return reply.code(200).send({ ok: true });
      if (event === "push") {
        // Standing index (LATENCY-PLAN §2.2.3): every push to a branch updates that branch's index off the review path.
        let push: { ref?: string; after?: string; deleted?: boolean; installation?: { id?: number }; repository?: { full_name?: string } };
        try { push = JSON.parse(raw.toString("utf8")); } catch { return reply.code(400).send(err("invalid_request", "invalid JSON")); }
        const branch = push.ref?.startsWith("refs/heads/") ? push.ref.slice(11) : undefined;
        if (!branch || push.deleted || !/^[0-9a-f]{40}$/.test(push.after ?? "")) return reply.code(202).send({ ignored: "push" });
        if (!push.installation?.id || !push.repository?.full_name) return reply.code(400).send(err("invalid_request", "missing push fields"));
        const tenantId = await deps.resolveInstallation?.(String(push.installation.id));
        if (!tenantId) return reply.code(404).send(err("unknown_installation", "installation is not linked to a tenant"));
        const indexId = createHash("sha256").update(`${push.repository.full_name}@${push.after}`).digest("hex").slice(0, 32);
        await deps.enqueue("index.requested", tenantId, { indexId, repositoryId: `github:${push.repository.full_name}`, commitSha: push.after!, mode: "incremental", branch }, { jobId: `index-${indexId}` });
        return reply.code(202).send({ indexId });
      }
      if (event !== "pull_request") return reply.code(202).send({ ignored: event ?? null });
      let body: { action?: string; installation?: { id?: number }; repository?: { full_name?: string; name?: string; owner?: { login?: string } }; pull_request?: { number?: number; head?: { sha?: string }; base?: { sha?: string } } };
      try { body = JSON.parse(raw.toString("utf8")); } catch { return reply.code(400).send(err("invalid_request", "invalid JSON")); }
      if (!["opened", "synchronize", "reopened"].includes(body.action ?? "")) return reply.code(202).send({ ignored: body.action ?? null });
      const repo = body.repository, pr = body.pull_request;
      if (!body.installation?.id || !repo?.full_name || !repo.name || !repo.owner?.login || !pr?.number || !pr.head?.sha) return reply.code(400).send(err("invalid_request", "missing pull_request fields"));
      const tenantId = await deps.resolveInstallation?.(String(body.installation.id));
      if (!tenantId) return reply.code(404).send(err("unknown_installation", "installation is not linked to a tenant"));
      const review = await startReview(tenantId, { id: prReviewId(repo.full_name, pr.number, pr.head.sha), repositoryId: `github:${repo.full_name}`,
        pullRequest: { provider: "github", owner: repo.owner.login, repo: repo.name, number: pr.number, headSha: pr.head.sha, ...(pr.base?.sha ? { baseSha: pr.base.sha } : {}) } });
      return reply.code(202).send({ reviewId: review.id });
    });
  });

  // ---------- reviews ----------
  app.post(routes.createReview.path, async (req, reply) => {
    const body = CreateReviewRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const b = body.data;
    const review = await startReview(tenant(req), { id: randomUUID(), repositoryId: b.repositoryId, ...(b.kind === "pull_request" ? { pullRequest: b.pullRequest } : { diff: b.diff }) });
    return reply.code(201).send(review);
  });

  const loadReview = (t: string, rid: string) => deps.db ? tx(t, (sql) => getReview(sql, rid)) : Promise.resolve(mem.reviews.get(memKey(t, rid)));

  app.get(routes.getReview.path, async (req, reply) => {
    const r = await loadReview(tenant(req), id(req));
    return r ? r : reply.code(404).send(err("not_found", "review not found"));
  });

  app.get(routes.listFindings.path, async (req, reply) => {
    const t = tenant(req);
    if (!deps.db) { const r = mem.reviews.get(memKey(t, id(req))); return r ? { findings: r.findings } : reply.code(404).send(err("not_found", "review not found")); }
    const out = await tx(t, async (sql) => (await getReview(sql, id(req), { withFindings: false })) ? { findings: await listFindings(sql, id(req)) } : undefined);
    return out ?? reply.code(404).send(err("not_found", "review not found"));
  });

  app.get(routes.reviewEvents.path, async (req, reply) => {
    const t = tenant(req), rid = id(req);
    const review = await loadReview(t, rid);
    if (!review) return reply.code(404).send(err("not_found", "review not found"));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-request-id": req.id });
    const send = (e: ReviewEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (["completed", "failed", "cancelled"].includes(review.status)) { send({ type: "completed", reviewId: rid, review }); res.end(); return; }
    send({ type: "status", reviewId: rid, status: review.status });
    const onEvent = (b: BusEvent) => {
      if (b.tenantId !== t || b.event.reviewId !== rid) return;
      send(b.event);
      if (b.event.type === "completed" || b.event.type === "error") close();
    };
    const close = () => { deps.events?.off(REVIEW_EVENT, onEvent); res.end(); };
    deps.events?.on(REVIEW_EVENT, onEvent);
    req.raw.on("close", () => deps.events?.off(REVIEW_EVENT, onEvent));
  });

  app.post(routes.createFeedback.path, async (req, reply) => {
    const body = CreateFeedbackRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    if (!deps.db) return reply.code(501).send(err("not_available", "feedback requires the database"));
    const t = tenant(req);
    const fb = await tx(t, (sql) => addFeedback(sql, t, id(req), body.data));
    return fb ? reply.code(201).send(fb) : reply.code(404).send(err("not_found", "finding not found"));
  });

  // ---------- config ----------
  app.get(routes.getConfig.path, async (req) => {
    const t = tenant(req);
    return deps.db ? tx(t, (sql) => getTenantConfig(sql, t)) : mem.configs.get(t) ?? TenantConfig.parse({});
  });
  app.put(routes.putConfig.path, async (req, reply) => {
    const body = TenantConfig.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const t = tenant(req);
    if (deps.db) return tx(t, (sql) => putTenantConfig(sql, t, body.data));
    mem.configs.set(t, body.data);
    return body.data;
  });

  // ---------- indexes ----------
  app.post(routes.createIndex.path, async (req, reply) => {
    const body = CreateIndexRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const t = tenant(req), b = body.data, iid = randomUUID();
    const rec: RepoIndex = deps.db
      ? await tx(t, (sql) => createIndexRecord(sql, t, { id: iid, repositoryId: b.repositoryId, commitSha: b.commitSha, embedModel: EMBED_MODEL }))
      : { id: iid, repositoryId: b.repositoryId, commitSha: b.commitSha, status: "pending", languages: [], fileCount: 0, symbolCount: 0, chunkCount: 0, embeddingModel: EMBED_MODEL };
    if (!deps.db) mem.indexes.set(memKey(t, iid), rec);
    await deps.enqueue("index.requested", t, { indexId: iid, repositoryId: b.repositoryId, commitSha: b.commitSha, mode: b.incremental ? "incremental" : "full" }, { jobId: iid });
    return reply.code(202).send(rec);
  });
  app.get(routes.getIndex.path, async (req, reply) => {
    const t = tenant(req);
    const r = deps.db ? await tx(t, (sql) => getIndexRecord(sql, id(req))) : mem.indexes.get(memKey(t, id(req)));
    return r ?? reply.code(404).send(err("not_found", "index not found"));
  });

  // ---------- test generation ----------
  app.post(routes.createTestGen.path, async (req, reply) => {
    const body = CreateTestGenRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const t = tenant(req), b = body.data, tid = randomUUID();
    const contextObjectKey = tenantKey(t, "agent-context", `${tid}.json`);
    await deps.store?.put(contextObjectKey, Buffer.from(JSON.stringify({ files: b.targetPaths.map((path) => ({ path, patch: "" })), rules: [] })));
    const rec: TestGenRun = deps.db
      ? await tx(t, (sql) => createTestGenRecord(sql, t, { id: tid, repositoryId: b.repositoryId, targetPaths: b.targetPaths, ...(b.reviewId ? { reviewId: b.reviewId } : {}) }))
      : { id: tid, repositoryId: b.repositoryId, status: "queued", targetPaths: b.targetPaths, testsKept: 0, testsDiscarded: 0, ...(b.reviewId ? { reviewId: b.reviewId } : {}) };
    if (!deps.db) mem.testgen.set(memKey(t, tid), rec);
    await deps.enqueue("agent.task", t, { reviewId: b.reviewId ?? tid, agentTaskId: tid, agent: "test-gen", tier: "medium", contextObjectKey, budgetUsd: 0.5 }, { jobId: tid });
    return reply.code(202).send(rec);
  });
  app.get(routes.getTestGen.path, async (req, reply) => {
    const t = tenant(req);
    const r = deps.db ? await tx(t, (sql) => getTestGenRecord(sql, id(req))) : mem.testgen.get(memKey(t, id(req)));
    return r ?? reply.code(404).send(err("not_found", "test generation run not found"));
  });

  // ---------- scores ----------
  app.post(routes.score.path, async (req, reply) => {
    const body = ScoreRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const t = tenant(req), sid = randomUUID();
    const job: ScoreJob = deps.db
      ? await tx(t, (sql) => createScoreJob(sql, t, { id: sid, ...body.data, rubricVersion: RUBRIC_VERSION }))
      : { id: sid, ...body.data, status: "queued" };
    if (!deps.db) mem.scores.set(memKey(t, sid), job);
    await deps.enqueue("score.requested", t, { scoreId: sid, ...body.data, rubricVersion: RUBRIC_VERSION }, { jobId: sid });
    return reply.code(202).send(job);
  });
  app.get(routes.getScore.path, async (req, reply) => {
    const t = tenant(req);
    const r = deps.db ? await tx(t, (sql) => getScoreJob(sql, id(req))) : mem.scores.get(memKey(t, id(req)));
    return r ?? reply.code(404).send(err("not_found", "score not found"));
  });

  return app;
}
