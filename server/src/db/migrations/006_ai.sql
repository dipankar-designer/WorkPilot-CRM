-- WorkPilot AI — Phase 6: AI assistant history. The assistant is read-only: it answers from data
-- the asking user is already allowed to see and never changes records. Each question and answer
-- (or failure) is kept for the user who asked.

CREATE TABLE ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 2000),
  answer text CHECK (answer IS NULL OR length(answer) <= 20000),
  status text NOT NULL CHECK (status IN ('answered', 'failed')),
  error_code text,
  provider text,
  model text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_user_idx ON ai_requests (org_id, user_id, created_at DESC);

GRANT SELECT, INSERT ON ai_requests TO workpilot_app;
ALTER TABLE ai_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_requests_own ON ai_requests FOR SELECT TO workpilot_app USING (org_id = app.org() AND user_id = app.uid());
CREATE POLICY ai_requests_insert ON ai_requests FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND user_id = app.uid() AND app.has_permission('ai.use'));
