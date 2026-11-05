-- WorkPilot AI — Phase 4: team chat. One-to-one, group and team channels with explicit members;
-- project channels (internal project team) and client channels (project team plus the project's
-- clients) whose access follows the project. Read receipts come from each member's last read
-- message sequence. Presence and typing are ephemeral and never stored.

CREATE TABLE chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('direct', 'group', 'team', 'project', 'client')),
  name text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 80),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  -- "userA:userB" (sorted) for direct conversations, so each pair has one conversation.
  direct_key text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((kind IN ('project', 'client')) = (project_id IS NOT NULL)),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CHECK (kind IN ('direct', 'project', 'client') OR name IS NOT NULL),
  UNIQUE (org_id, direct_key)
);
CREATE UNIQUE INDEX chat_channels_project_kind ON chat_channels (project_id, kind) WHERE project_id IS NOT NULL;

CREATE TABLE chat_members (
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_seq bigint NOT NULL DEFAULT 0,
  last_read_at timestamptz,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id, org_id);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) <= 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX chat_messages_channel_idx ON chat_messages (channel_id, seq DESC);

ALTER TABLE files ADD CONSTRAINT files_channel_fkey FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN message_id uuid REFERENCES chat_messages(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------- access
CREATE FUNCTION app.can_access_channel(p_channel uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_channels c
     WHERE c.id = p_channel AND c.org_id = app.org() AND c.archived_at IS NULL
       AND CASE c.kind
             WHEN 'project' THEN app.can_work_on_project(c.project_id)
             WHEN 'client' THEN app.can_work_on_project(c.project_id) OR app.project_role(c.project_id) = 'client'
             ELSE app.is_internal() AND EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = app.uid())
           END)
$$;

-- Explicit-membership channels are internal: clients talk to the team in client channels only.
CREATE FUNCTION app.check_chat_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_project uuid;
BEGIN
  SELECT kind, project_id INTO v_kind, v_project FROM chat_channels WHERE id = NEW.channel_id;
  IF v_kind IN ('direct', 'group', 'team') AND EXISTS (SELECT 1 FROM member_roles WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND role_key = 'client') THEN
    RAISE EXCEPTION 'Clients can only join client channels of their projects.' USING ERRCODE = 'P0001', HINT = 'chat_client';
  END IF;
  IF v_kind = 'direct' AND (SELECT count(*) FROM chat_members WHERE channel_id = NEW.channel_id AND user_id <> NEW.user_id) >= 2 THEN
    RAISE EXCEPTION 'A direct conversation has exactly two people.' USING ERRCODE = 'P0001', HINT = 'chat_direct';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_members_check BEFORE INSERT ON chat_members FOR EACH ROW EXECUTE FUNCTION app.check_chat_member();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO workpilot_app;

GRANT SELECT, INSERT ON chat_channels TO workpilot_app;
GRANT UPDATE (name, archived_at) ON chat_channels TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON chat_members TO workpilot_app;
GRANT UPDATE (last_read_seq, last_read_at) ON chat_members TO workpilot_app;
GRANT SELECT, INSERT ON chat_messages TO workpilot_app;
GRANT UPDATE (body, edited_at, deleted_at) ON chat_messages TO workpilot_app;

ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY channels_read ON chat_channels FOR SELECT TO workpilot_app
  USING (app.can_access_channel(id) OR (created_by = app.uid() AND org_id = app.org()));
CREATE POLICY channels_insert ON chat_channels FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND created_by = app.uid() AND (
    (kind IN ('direct', 'group', 'team') AND app.is_internal())
    OR (kind = 'project' AND app.can_work_on_project(project_id))
    OR (kind = 'client' AND app.can_work_on_project(project_id))));
CREATE POLICY channels_update ON chat_channels FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (created_by = app.uid() OR (project_id IS NOT NULL AND app.can_manage_project(project_id))))
  WITH CHECK (org_id = app.org());

-- Members of a channel see each other (for read receipts and member lists).
CREATE POLICY chat_members_read ON chat_members FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.can_access_channel(channel_id));
-- Join yourself to a channel you can access (project/client channels), or add people to a
-- channel you created or belong to.
CREATE POLICY chat_members_insert ON chat_members FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND (
    (user_id = app.uid() AND app.can_access_channel(channel_id))
    OR EXISTS (SELECT 1 FROM chat_channels c WHERE c.id = channel_id AND c.org_id = app.org() AND c.kind IN ('direct', 'group', 'team')
               AND (c.created_by = app.uid() OR app.can_access_channel(c.id)))));
CREATE POLICY chat_members_update ON chat_members FOR UPDATE TO workpilot_app
  USING (user_id = app.uid() AND org_id = app.org()) WITH CHECK (user_id = app.uid());
CREATE POLICY chat_members_delete ON chat_members FOR DELETE TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR EXISTS (SELECT 1 FROM chat_channels c WHERE c.id = channel_id AND c.created_by = app.uid() AND c.kind IN ('group', 'team'))));

CREATE POLICY messages_read ON chat_messages FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.can_access_channel(channel_id));
CREATE POLICY messages_insert ON chat_messages FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND author_id = app.uid() AND app.can_access_channel(channel_id));
CREATE POLICY messages_update ON chat_messages FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND author_id = app.uid() AND deleted_at IS NULL) WITH CHECK (author_id = app.uid());

CREATE POLICY files_channel_read ON files FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND channel_id IS NOT NULL AND app.can_access_channel(channel_id));
CREATE POLICY files_channel_insert ON files FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND uploaded_by = app.uid() AND channel_id IS NOT NULL AND project_id IS NULL AND app.can_access_channel(channel_id));
CREATE POLICY files_channel_update ON files FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND channel_id IS NOT NULL AND uploaded_by = app.uid()) WITH CHECK (org_id = app.org());
