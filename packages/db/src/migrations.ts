import { APP_ROLE, rlsPolicySql, type RlsTable } from "./rls.ts";

/**
 * Every table that holds tenant data. The isolation test asserts this list equals the set of tables with a
 * tenant_id column (plus the tenants root), so a new table without RLS fails CI.
 */
export const TENANT_TABLES: readonly RlsTable[] = [
  { table: "tenants", column: "id", grants: ["SELECT"] },
  { table: "installations" },
  { table: "repositories" },
  { table: "api_keys" },
  { table: "audit_log", grants: ["SELECT", "INSERT"] },
  { table: "tenant_configs" },
  { table: "rules" },
  { table: "repo_indexes" },
  { table: "index_files" },
  { table: "symbols" },
  { table: "symbol_edges" },
  { table: "chunks" },
  { table: "embedding_cache" },
  { table: "pull_requests" },
  { table: "reviews" },
  { table: "agent_tasks" },
  { table: "findings" },
  { table: "feedback" },
  { table: "suppressions" },
  { table: "test_gen_runs" },
  { table: "sandbox_runs" },
  { table: "score_reports" },
  { table: "usage_ledger", grants: ["SELECT", "INSERT"] },
];

/** Embedding dimension of chunks.embedding (fixed per HNSW index, ADR 0003). */
export const EMBEDDING_DIM = 1024;

const T = "tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE";
const ID = "id text PRIMARY KEY DEFAULT gen_random_uuid()::text";
const NOW = "created_at timestamptz NOT NULL DEFAULT now()";

export interface Migration { id: string; sql: string }

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_schema",
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS; END IF;
END $$;

CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, plan text NOT NULL DEFAULT 'free', kms_key_ref text, ${NOW});
CREATE TABLE installations (${ID}, ${T}, provider text NOT NULL, external_id text NOT NULL, settings jsonb NOT NULL DEFAULT '{}', ${NOW}, UNIQUE (provider, external_id));
CREATE TABLE repositories (${ID}, ${T}, installation_id text REFERENCES installations(id), provider text NOT NULL, full_name text NOT NULL, default_branch text NOT NULL DEFAULT 'main', ${NOW}, UNIQUE (tenant_id, provider, full_name));
CREATE TABLE api_keys (${ID}, ${T}, prefix text NOT NULL, key_hash bytea NOT NULL UNIQUE, scopes jsonb NOT NULL DEFAULT '[]', expires_at timestamptz, revoked_at timestamptz, ${NOW});
CREATE TABLE audit_log (id bigserial PRIMARY KEY, ${T}, actor text NOT NULL, action text NOT NULL, target text, detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tenant_configs (tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE rules (${ID}, ${T}, data jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, ${NOW});

CREATE TABLE repo_indexes (${ID}, ${T}, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, commit_sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','building','ready','failed')), base_index_id text REFERENCES repo_indexes(id),
  embed_model text NOT NULL, languages text[] NOT NULL DEFAULT '{}', file_count int NOT NULL DEFAULT 0, symbol_count int NOT NULL DEFAULT 0,
  chunk_count int NOT NULL DEFAULT 0, built_at timestamptz, ${NOW});
CREATE TABLE index_files (${T}, index_id text NOT NULL REFERENCES repo_indexes(id) ON DELETE CASCADE, path text NOT NULL, blob_sha text NOT NULL,
  language text, object_key text NOT NULL, PRIMARY KEY (index_id, path));
CREATE INDEX index_files_blob ON index_files (tenant_id, blob_sha);
CREATE TABLE symbols (${ID}, ${T}, index_id text NOT NULL REFERENCES repo_indexes(id) ON DELETE CASCADE, blob_sha text NOT NULL, path text NOT NULL,
  kind text NOT NULL, name text NOT NULL, fq_name text NOT NULL, start_line int NOT NULL, end_line int NOT NULL);
CREATE INDEX symbols_name ON symbols (index_id, name);
CREATE TABLE symbol_edges (id bigserial PRIMARY KEY, ${T}, index_id text NOT NULL REFERENCES repo_indexes(id) ON DELETE CASCADE,
  src_symbol_id text REFERENCES symbols(id) ON DELETE CASCADE, path text NOT NULL, kind text NOT NULL CHECK (kind IN ('call','import','var')),
  dst_name text NOT NULL, dst_symbol_id text REFERENCES symbols(id) ON DELETE SET NULL, line int NOT NULL);
CREATE INDEX symbol_edges_src ON symbol_edges (index_id, src_symbol_id);
CREATE INDEX symbol_edges_dst ON symbol_edges (index_id, dst_symbol_id);
CREATE TABLE chunks (${ID}, ${T}, index_id text NOT NULL REFERENCES repo_indexes(id) ON DELETE CASCADE, symbol_id text REFERENCES symbols(id) ON DELETE SET NULL,
  path text NOT NULL, start_line int NOT NULL, end_line int NOT NULL, blob_sha text NOT NULL, content_hash text NOT NULL,
  -- Chunk text is envelope-encrypted with the tenant DEK (ADR 0007); lexical tokens + embedding stay clear for search.
  content_ciphertext bytea NOT NULL, tsv tsvector NOT NULL, embedding vector(${EMBEDDING_DIM}));
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_index ON chunks (tenant_id, index_id);
CREATE TABLE embedding_cache (${T}, model text NOT NULL, content_hash text NOT NULL, embedding vector(${EMBEDDING_DIM}) NOT NULL, PRIMARY KEY (tenant_id, model, content_hash));

CREATE TABLE pull_requests (${ID}, ${T}, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, number int NOT NULL,
  head_sha text, base_sha text, state text NOT NULL DEFAULT 'open', ${NOW}, UNIQUE (tenant_id, repository_id, number));
CREATE TABLE reviews (${ID}, ${T}, repository_id text NOT NULL, pull_request_id text REFERENCES pull_requests(id), status text NOT NULL,
  summary text, pr jsonb, diff_object_key text, usage jsonb, cost_usd numeric(12,6) NOT NULL DEFAULT 0, ${NOW}, completed_at timestamptz);
CREATE TABLE agent_tasks (${ID}, ${T}, review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, kind text NOT NULL, tier text NOT NULL,
  model_id text, provider text, tokens_in int NOT NULL DEFAULT 0, tokens_out int NOT NULL DEFAULT 0, cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  status text NOT NULL, attempts jsonb NOT NULL DEFAULT '[]', ${NOW});
CREATE TABLE findings (${ID}, ${T}, review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, agent_task_id text REFERENCES agent_tasks(id),
  rule_id text, fingerprint text NOT NULL, category text NOT NULL, severity text NOT NULL, path text NOT NULL, start_line int NOT NULL, end_line int NOT NULL,
  confidence real NOT NULL, data jsonb NOT NULL, posted boolean NOT NULL DEFAULT false, ${NOW});
CREATE INDEX findings_review ON findings (tenant_id, review_id);
CREATE TABLE feedback (${ID}, ${T}, finding_id text NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('thumbs_up','thumbs_down','resolved','dismissed')), reason text, actor text, ${NOW});
CREATE TABLE suppressions (${ID}, ${T}, repository_id text NOT NULL, fingerprint text NOT NULL, reason text NOT NULL, ${NOW}, UNIQUE (tenant_id, repository_id, fingerprint));
CREATE TABLE test_gen_runs (${ID}, ${T}, review_id text, repository_id text NOT NULL, status text NOT NULL, target_paths text[] NOT NULL,
  attempts int NOT NULL DEFAULT 0, result jsonb NOT NULL DEFAULT '{}', ${NOW});
CREATE TABLE sandbox_runs (${ID}, ${T}, image text NOT NULL, command jsonb NOT NULL, status text NOT NULL, exit_code int, result_object_key text, ${NOW});
CREATE TABLE score_reports (${ID}, ${T}, review_id text, rubric_version text NOT NULL, dataset_version text NOT NULL, score real NOT NULL, data jsonb NOT NULL, ${NOW});
CREATE TABLE usage_ledger (id bigserial PRIMARY KEY, ${T}, review_id text, model text NOT NULL, input_tokens int NOT NULL, output_tokens int NOT NULL,
  cost_usd numeric(12,6) NOT NULL, at timestamptz NOT NULL DEFAULT now());

GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
`,
  },
  {
    id: "002_rls",
    sql: TENANT_TABLES.map(rlsPolicySql).join("\n"),
  },
  {
    id: "003_definer_lookups",
    // Pre-tenant lookups (API key auth, webhook installation) cannot see rows under RLS. These narrow
    // SECURITY DEFINER functions return only the tenant id for an exact match; nothing else crosses tenants.
    sql: `
CREATE FUNCTION auth_api_key(p_hash bytea) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT tenant_id FROM api_keys WHERE key_hash = p_hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) $$;
CREATE FUNCTION resolve_installation(p_provider text, p_external_id text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT tenant_id FROM installations WHERE provider = p_provider AND external_id = p_external_id $$;
REVOKE ALL ON FUNCTION auth_api_key(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_installation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_api_key(bytea) TO ${APP_ROLE};
GRANT EXECUTE ON FUNCTION resolve_installation(text, text) TO ${APP_ROLE};
`,
  },
];
