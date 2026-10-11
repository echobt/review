import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { CreateIndexRequest, CreateReviewRequest, CreateTestGenRequest, ScoreRequest, routes, type Message, type QueueName, type Review } from "@review/core";

/** Port for enqueueing; real impl = BullMQ producers, tests = in-memory. */
export type Enqueue = <Q extends QueueName>(queue: Q, tenantId: string, payload: Message<Q>["payload"]) => Promise<void>;
/** Resolves a bearer API key to a tenant id (real impl: hashed key lookup in api_keys). */
export type Authenticate = (apiKey: string) => Promise<string | undefined>;

export function buildApp(deps: { enqueue: Enqueue; authenticate: Authenticate }): FastifyInstance {
  const app = Fastify({ logger: false });
  const err = (code: string, message: string) => ({ error: { code, message } });

  app.get(routes.health.path, async () => ({ ok: true }));

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === routes.health.path) return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const tenantId = m ? await deps.authenticate(m[1]!) : undefined;
    if (!tenantId) return reply.code(401).send(err("unauthorized", "missing or invalid API key"));
    (req as unknown as { tenantId: string }).tenantId = tenantId;
  });
  const tenant = (req: unknown) => (req as { tenantId: string }).tenantId;

  app.post(routes.createReview.path, async (req, reply) => {
    const body = CreateReviewRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const review: Review = { id: randomUUID(), tenantId: tenant(req), repositoryId: body.data.repositoryId, status: "queued", findings: [],
      createdAt: new Date().toISOString(), ...(body.data.kind === "pull_request" ? { pullRequest: body.data.pullRequest } : {}) };
    // PROPOSAL: diffs are written to tenant-prefixed object storage; key only travels on the queue.
    await deps.enqueue("review.requested", review.tenantId, { reviewId: review.id, repositoryId: review.repositoryId,
      ...(review.pullRequest ? { pullRequest: review.pullRequest } : { diffObjectKey: `${review.tenantId}/diffs/${review.id}.patch` }) });
    return reply.code(201).send(review);
  });

  app.post(routes.createIndex.path, async (req, reply) => {
    const body = CreateIndexRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    const id = randomUUID();
    await deps.enqueue("index.requested", tenant(req), { indexId: id, repositoryId: body.data.repositoryId, commitSha: body.data.commitSha, mode: body.data.incremental ? "incremental" : "full" });
    return reply.code(202).send({ id, repositoryId: body.data.repositoryId, commitSha: body.data.commitSha, status: "pending", languages: [],
      fileCount: 0, symbolCount: 0, chunkCount: 0, embeddingModel: "unset" });
  });

  app.post(routes.createTestGen.path, async (req, reply) => {
    const body = CreateTestGenRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    // Skeleton: persistence + agent.task dispatch land in phase 3 (docs/PLAN.md).
    return reply.code(202).send({ id: randomUUID(), repositoryId: body.data.repositoryId, status: "queued", targetPaths: body.data.targetPaths, testsKept: 0, testsDiscarded: 0 });
  });

  app.post(routes.score.path, async (req, reply) => {
    const body = ScoreRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send(err("invalid_request", body.error.message));
    await deps.enqueue("score.requested", tenant(req), { ...body.data, rubricVersion: "1.0.0" });
    return reply.code(501).send(err("not_implemented", "scores are delivered asynchronously in phase 4"));
  });

  return app;
}
