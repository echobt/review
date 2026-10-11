-- Phase-0 schema skeleton. Tenant isolation via RLS (ADR-0007).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repositories (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), provider text NOT NULL, full_name text NOT NULL, UNIQUE (tenant_id, provider, full_name));
CREATE TABLE api_keys (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), key_hash bytea NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE repo_indexes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, repository_id uuid NOT NULL REFERENCES repositories(id), commit_sha text NOT NULL, status text NOT NULL, embedding_model text NOT NULL, base_index_id uuid REFERENCES repo_indexes(id), built_at timestamptz);
CREATE TABLE chunks (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, index_id uuid NOT NULL REFERENCES repo_indexes(id) ON DELETE CASCADE, path text NOT NULL, start_line int NOT NULL, end_line int NOT NULL, symbol text, content_hash bytea NOT NULL, embedding vector(1024));
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE TABLE reviews (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, repository_id uuid NOT NULL REFERENCES repositories(id), status text NOT NULL, pr jsonb, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE TABLE findings (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, data jsonb NOT NULL, severity text NOT NULL, confidence real NOT NULL);
CREATE TABLE feedback (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE, verdict text NOT NULL CHECK (verdict IN ('accepted','dismissed','fixed')), created_at timestamptz NOT NULL DEFAULT now());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['repositories','api_keys','repo_indexes','chunks','reviews','findings','feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;
