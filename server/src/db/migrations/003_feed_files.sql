-- WorkPilot AI — Phase 3: project feed (posts, comments and replies, reactions, mentions,
-- pinning, internal versus client-visible updates), project files and links, and invitations that
-- add people straight to a project.

-- ---------------------------------------------------------------- invitations into a project
ALTER TABLE invitations ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

-- Project managers (not only owners and HR) may invite client guests to their own projects.
DROP POLICY invitations_insert ON invitations;
CREATE POLICY invitations_insert ON invitations FOR INSERT TO workpilot_app
  WITH CHECK (
    org_id = app.org() AND invited_by = app.uid()
    AND (
      (app.has_permission('members.invite') AND (NOT ('owner' = ANY (roles)) OR app.has_permission('members.manage_roles')))
      OR (roles = ARRAY['client']::text[] AND project_id IS NOT NULL AND app.has_permission('clients.manage') AND app.can_manage_project(project_id))
    )
  );
DROP POLICY invitations_read ON invitations;
CREATE POLICY invitations_read ON invitations FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (app.has_permission('members.invite') OR (invited_by = app.uid() AND app.has_permission('clients.manage'))));
DROP POLICY invitations_revoke ON invitations;
CREATE POLICY invitations_revoke ON invitations FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (app.has_permission('members.invite') OR (invited_by = app.uid() AND app.has_permission('clients.manage'))))
  WITH CHECK (org_id = app.org());

-- ---------------------------------------------------------------- feed
CREATE TABLE feed_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'update' CHECK (kind IN ('update', 'announcement', 'question', 'progress')),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'client')),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  link_url text CHECK (link_url IS NULL OR (link_url ~ '^https?://' AND length(link_url) <= 2000)),
  pinned_at timestamptz,
  pinned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (project_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX feed_posts_project_idx ON feed_posts (project_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE feed_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  post_id uuid NOT NULL,
  parent_id uuid REFERENCES feed_comments(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY (project_id, post_id) REFERENCES feed_posts(project_id, id) ON DELETE CASCADE
);
CREATE INDEX feed_comments_post_idx ON feed_comments (post_id, created_at);

CREATE TABLE feed_reactions (
  post_id uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji IN ('👍', '🎉', '❤️', '👀', '✅')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('post', 'comment', 'task_comment', 'message')),
  source_id uuid NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, mentioned_user_id)
);
CREATE INDEX mentions_user_idx ON mentions (mentioned_user_id, created_at DESC);

-- ---------------------------------------------------------------- files and links
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid,                                        -- chat attachments (Phase 4)
  post_id uuid REFERENCES feed_posts(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file', 'link')),
  category text NOT NULL DEFAULT 'document' CHECK (category IN ('image', 'document', 'pdf', 'design', 'brief', 'link', 'other')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  mime_type text CHECK (mime_type IS NULL OR length(mime_type) <= 120),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  storage_key text UNIQUE CHECK (storage_key IS NULL OR storage_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  url text CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2000)),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'client')),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((kind = 'file') = (storage_key IS NOT NULL)),
  CHECK ((kind = 'link') = (url IS NOT NULL)),
  CHECK (project_id IS NOT NULL OR channel_id IS NOT NULL)
);
CREATE INDEX files_project_idx ON files (project_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX files_post_idx ON files (post_id);
CREATE INDEX files_task_idx ON files (task_id);
CREATE INDEX files_channel_idx ON files (channel_id);

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION app.can_see_post(p_post uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM feed_posts f
     WHERE f.id = p_post AND f.org_id = app.org() AND f.deleted_at IS NULL
       AND app.can_view_project(f.project_id)
       AND (app.is_internal() OR f.visibility = 'client'))
$$;

-- Whether the current user may write in a project's feed (clients only when the project allows it).
CREATE FUNCTION app.can_post_in_project(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app.can_view_project(p_project) AND (
    app.is_internal() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.clients_can_post AND app.project_role(p.id) = 'client'))
$$;

-- Only the author edits a post; managers may additionally pin or remove it.
CREATE FUNCTION app.guard_post_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.author_id IS DISTINCT FROM app.uid() AND session_user = 'workpilot_app' THEN
    IF (NEW.body, NEW.kind, NEW.visibility, NEW.link_url, NEW.edited_at) IS DISTINCT FROM (OLD.body, OLD.kind, OLD.visibility, OLD.link_url, OLD.edited_at) THEN
      RAISE EXCEPTION 'Only the author can edit this post.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT app.is_internal() AND session_user = 'workpilot_app' AND NEW.visibility <> 'client' THEN
    RAISE EXCEPTION 'Clients can only post client-visible updates.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER feed_posts_guard BEFORE UPDATE ON feed_posts FOR EACH ROW EXECUTE FUNCTION app.guard_post_update();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO workpilot_app;

-- ---------------------------------------------------------------- privileges and policies
GRANT SELECT, INSERT ON feed_posts TO workpilot_app;
GRANT UPDATE (body, kind, visibility, link_url, edited_at, deleted_at, pinned_at, pinned_by) ON feed_posts TO workpilot_app;
GRANT SELECT, INSERT ON feed_comments TO workpilot_app;
GRANT UPDATE (body, edited_at, deleted_at) ON feed_comments TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON feed_reactions TO workpilot_app;
GRANT SELECT, INSERT ON mentions TO workpilot_app;
GRANT SELECT, INSERT ON files TO workpilot_app;
GRANT UPDATE (deleted_at, visibility, name) ON files TO workpilot_app;

ALTER TABLE feed_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

CREATE POLICY posts_read ON feed_posts FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND app.can_view_project(project_id) AND (app.is_internal() OR visibility = 'client'));
CREATE POLICY posts_insert ON feed_posts FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND author_id = app.uid() AND app.can_post_in_project(project_id)
    AND (app.is_internal() OR visibility = 'client') AND pinned_at IS NULL);
CREATE POLICY posts_update ON feed_posts FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND deleted_at IS NULL AND (author_id = app.uid() OR app.can_manage_project(project_id)))
  WITH CHECK (org_id = app.org());

CREATE POLICY comments_read ON feed_comments FOR SELECT TO workpilot_app USING (app.can_see_post(post_id));
CREATE POLICY comments_insert ON feed_comments FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND author_id = app.uid() AND app.can_see_post(post_id) AND app.can_post_in_project(project_id));
CREATE POLICY comments_update ON feed_comments FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (author_id = app.uid() OR app.can_manage_project(project_id)))
  WITH CHECK (org_id = app.org());

CREATE POLICY reactions_read ON feed_reactions FOR SELECT TO workpilot_app USING (app.can_see_post(post_id));
CREATE POLICY reactions_insert ON feed_reactions FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND user_id = app.uid() AND app.can_see_post(post_id));
CREATE POLICY reactions_delete ON feed_reactions FOR DELETE TO workpilot_app USING (user_id = app.uid());

CREATE POLICY mentions_read ON mentions FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (mentioned_user_id = app.uid() OR created_by = app.uid()));
CREATE POLICY mentions_insert ON mentions FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND created_by = app.uid());

-- Project files: internal members see everything in projects they can view; clients only files
-- explicitly shared with them (visibility = client). Task files follow task visibility.
CREATE POLICY files_project_read ON files FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND project_id IS NOT NULL AND app.can_view_project(project_id)
    AND (app.is_internal() OR visibility = 'client')
    AND (task_id IS NULL OR app.can_view_tasks(project_id))
    AND (post_id IS NULL OR app.can_see_post(post_id)));
CREATE POLICY files_project_insert ON files FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND uploaded_by = app.uid() AND project_id IS NOT NULL
    AND app.can_post_in_project(project_id) AND (app.is_internal() OR visibility = 'client')
    AND (task_id IS NULL OR app.can_work_on_project(project_id)));
CREATE POLICY files_project_update ON files FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND project_id IS NOT NULL AND (uploaded_by = app.uid() OR app.can_manage_project(project_id)))
  WITH CHECK (org_id = app.org() AND (app.is_internal() OR visibility = 'client'));
