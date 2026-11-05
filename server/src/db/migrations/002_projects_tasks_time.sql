-- WorkPilot AI — Phase 2: clients, projects, project membership, Kanban boards, tasks and
-- subtasks, labels, comments, project activity, time tracking, timesheets and notifications.
--
-- Visibility rules (enforced here with RLS, mirrored by API guards for clear messages)
--   * A project is visible to holders of `projects.view_all` (owners, finance managers), its
--     manager and its members. Clients see only projects they were added to as clients.
--   * Internal project members and managers (and owners) work on tasks. Clients see tasks only
--     when the project allows it (`client_task_access`), and never time entries.
--   * Time entries are private to their owner, plus people with `time.view_all` or
--     `time.approve`, plus the manager of the entry's project.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Finance managers need every project for budget and billable reporting.
INSERT INTO role_permissions (role_key, permission_key) VALUES ('finance_manager', 'projects.view_all') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- clients
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  contact_name text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  email text CHECK (email IS NULL OR (email = lower(btrim(email)) AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  country text CHECK (country IS NULL OR length(country) <= 80),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  archived_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX clients_org_idx ON clients (org_id, name);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 8000),
  manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  start_date date,
  deadline date,
  estimated_hours numeric(10, 2) CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  budget numeric(14, 2) CHECK (budget IS NULL OR budget >= 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  client_task_access boolean NOT NULL DEFAULT false,
  clients_can_post boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (deadline IS NULL OR start_date IS NULL OR deadline >= start_date),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) ON DELETE SET NULL (client_id)
);
CREATE INDEX projects_org_idx ON projects (org_id, status);
CREATE INDEX projects_deadline_idx ON projects (org_id, deadline) WHERE archived_at IS NULL;

CREATE TABLE project_members (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member', 'client')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  last_seen_feed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX project_members_user_idx ON project_members (user_id, org_id);

CREATE TABLE project_favourites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

-- ---------------------------------------------------------------- board, tasks
CREATE TABLE board_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  position int NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX board_columns_project_idx ON board_columns (project_id, position);

CREATE TABLE task_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  color text NOT NULL DEFAULT 'blue' CHECK (color IN ('blue', 'green', 'amber', 'red', 'purple', 'grey')),
  UNIQUE (project_id, name),
  UNIQUE (project_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  column_id uuid NOT NULL,
  parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR length(description) <= 20000),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date date,
  estimated_hours numeric(8, 2) CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  position int NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, column_id) REFERENCES board_columns(project_id, id)
);
CREATE INDEX tasks_column_idx ON tasks (column_id, position);
CREATE INDEX tasks_project_idx ON tasks (project_id);
CREATE INDEX tasks_parent_idx ON tasks (parent_id);
CREATE INDEX tasks_due_idx ON tasks (org_id, due_date) WHERE completed_at IS NULL;

CREATE TABLE task_assignees (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

CREATE TABLE task_label_links (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

-- Project and task history, shown in the project workspace and on each task.
CREATE TABLE project_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  summary text NOT NULL CHECK (length(summary) <= 500),
  -- Internal activity is never shown to clients.
  client_visible boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_activity_project_idx ON project_activity (project_id, created_at DESC);
CREATE INDEX project_activity_task_idx ON project_activity (task_id, created_at DESC);

-- ---------------------------------------------------------------- time tracking
CREATE TABLE timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  total_seconds int NOT NULL DEFAULT 0,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  UNIQUE (org_id, user_id, week_start),
  CHECK (decided_by IS NULL OR decided_by <> user_id)
);
CREATE INDEX timesheets_status_idx ON timesheets (org_id, status);

CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  description text CHECK (description IS NULL OR length(description) <= 1000),
  billable boolean NOT NULL DEFAULT true,
  source text NOT NULL CHECK (source IN ('timer', 'manual')),
  status text NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  paused_at timestamptz,
  paused_seconds int NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
  duration_seconds int CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  timesheet_id uuid REFERENCES timesheets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE,
  CHECK ((status = 'stopped') = (ended_at IS NOT NULL)),
  CHECK ((status = 'paused') = (paused_at IS NOT NULL)),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK (ended_at IS NULL OR ended_at - started_at <= interval '24 hours'),
  -- Stopped entries of one person never overlap.
  EXCLUDE USING gist (user_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&) WHERE (ended_at IS NOT NULL)
);
-- One running or paused timer per person.
CREATE UNIQUE INDEX time_entries_one_active ON time_entries (user_id) WHERE status IN ('running', 'paused');
CREATE INDEX time_entries_user_time_idx ON time_entries (org_id, user_id, started_at DESC);
CREATE INDEX time_entries_project_idx ON time_entries (project_id, started_at);

-- Monday of the week containing `ts` in the organisation's timezone.
CREATE FUNCTION app.week_start(ts timestamptz, tz text) RETURNS date
LANGUAGE sql IMMUTABLE
AS $$ SELECT date_trunc('week', ts AT TIME ZONE tz)::date $$;

-- The submitted or approved timesheet that locks a person's week, if any.
CREATE FUNCTION app.locking_timesheet(p_org uuid, p_user uuid, p_started timestamptz) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.id FROM timesheets t JOIN organizations o ON o.id = t.org_id
   WHERE t.org_id = p_org AND t.user_id = p_user AND t.status IN ('submitted', 'approved')
     AND t.week_start = app.week_start(p_started, o.timezone)
$$;

-- Time in a submitted or approved week cannot be added, changed or deleted silently. The only
-- change allowed is linking entries to that week's timesheet (done by the submission itself),
-- and clearing the task when a task is deleted.
CREATE FUNCTION app.protect_locked_time() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_lock uuid;
  v_new_lock uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_lock := app.locking_timesheet(OLD.org_id, OLD.user_id, OLD.started_at);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_lock := app.locking_timesheet(NEW.org_id, NEW.user_id, NEW.started_at);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_lock IS NOT NULL THEN
      RAISE EXCEPTION 'This time is in a submitted or approved timesheet and cannot be deleted.' USING ERRCODE = 'P0001', HINT = 'time_locked';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_lock IS NOT NULL THEN
      RAISE EXCEPTION 'That week’s timesheet has already been submitted. Time cannot be added to it.' USING ERRCODE = 'P0001', HINT = 'time_locked';
    END IF;
    RETURN NEW;
  END IF;

  IF v_old_lock IS NOT NULL OR v_new_lock IS NOT NULL THEN
    IF (NEW.user_id, NEW.project_id, NEW.description, NEW.billable, NEW.status, NEW.started_at, NEW.ended_at, NEW.paused_at, NEW.paused_seconds, NEW.duration_seconds)
       IS NOT DISTINCT FROM
       (OLD.user_id, OLD.project_id, OLD.description, OLD.billable, OLD.status, OLD.started_at, OLD.ended_at, OLD.paused_at, OLD.paused_seconds, OLD.duration_seconds)
       AND (NEW.task_id IS NOT DISTINCT FROM OLD.task_id OR NEW.task_id IS NULL)
       AND (NEW.timesheet_id IS NOT DISTINCT FROM OLD.timesheet_id OR NEW.timesheet_id = coalesce(v_new_lock, v_old_lock)) THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This time is in a submitted or approved timesheet and cannot be changed.' USING ERRCODE = 'P0001', HINT = 'time_locked';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER time_entries_locked BEFORE INSERT OR UPDATE OR DELETE ON time_entries FOR EACH ROW EXECUTE FUNCTION app.protect_locked_time();

-- Timesheet transitions: the owner may only resubmit a rejected week; an approver may only
-- approve or reject a submitted one. An approved timesheet never changes again.
CREATE FUNCTION app.guard_timesheet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user <> 'workpilot_app' THEN RETURN NEW; END IF;
  IF (NEW.user_id, NEW.org_id, NEW.week_start) IS DISTINCT FROM (OLD.user_id, OLD.org_id, OLD.week_start) THEN
    RAISE EXCEPTION 'A timesheet’s person and week cannot change.' USING ERRCODE = 'P0001', HINT = 'timesheet_state';
  END IF;
  IF OLD.user_id = app.uid() THEN
    IF NOT (OLD.status = 'rejected' AND NEW.status = 'submitted') THEN
      RAISE EXCEPTION 'Only a rejected timesheet can be resubmitted.' USING ERRCODE = 'P0001', HINT = 'timesheet_state';
    END IF;
  ELSIF NOT (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected')) THEN
    RAISE EXCEPTION 'Only a submitted timesheet can be approved or rejected.' USING ERRCODE = 'P0001', HINT = 'timesheet_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheets_guard BEFORE UPDATE ON timesheets FOR EACH ROW EXECUTE FUNCTION app.guard_timesheet();

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  title text NOT NULL CHECK (length(title) <= 300),
  body text CHECK (body IS NULL OR length(body) <= 1000),
  link text CHECK (link IS NULL OR link ~ '^/[^/]'),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, org_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id, org_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION app.project_role(p_project uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT pm.role FROM project_members pm
   WHERE pm.project_id = p_project AND pm.user_id = app.uid() AND pm.org_id = app.org()
$$;

CREATE FUNCTION app.can_view_project(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
     WHERE p.id = p_project AND p.org_id = app.org()
       AND (app.has_permission('projects.view_all') OR p.manager_id = app.uid() OR app.project_role(p.id) IS NOT NULL))
$$;

-- Internal people who work on the project: owners, the manager and internal project members.
CREATE FUNCTION app.can_work_on_project(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app.is_internal() AND EXISTS (
    SELECT 1 FROM projects p
     WHERE p.id = p_project AND p.org_id = app.org()
       AND (app.has_role('owner') OR p.manager_id = app.uid() OR app.project_role(p.id) IN ('manager', 'member')))
$$;

CREATE FUNCTION app.can_manage_project(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app.is_internal() AND EXISTS (
    SELECT 1 FROM projects p
     WHERE p.id = p_project AND p.org_id = app.org()
       AND (app.has_role('owner') OR p.manager_id = app.uid() OR app.project_role(p.id) = 'manager'))
$$;

-- Internal viewers, plus clients of the project when it shares its tasks.
CREATE FUNCTION app.can_view_tasks(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app.can_view_project(p_project) AND (
    app.is_internal() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.client_task_access))
$$;

CREATE FUNCTION app.task_project(p_task uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT project_id FROM tasks WHERE id = p_task AND org_id = app.org() $$;

CREATE FUNCTION app.can_view_time_entry(p_user uuid, p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p_user = app.uid()
      OR app.has_permission('time.view_all')
      OR app.has_permission('time.approve')
      OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = app.org() AND p.manager_id = app.uid())
$$;

-- Whether someone is an active member of the current organisation. Lets clients (who cannot list
-- members) notify the team, without revealing anything else.
CREATE FUNCTION app.is_active_member(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $f$ SELECT EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = app.org() AND m.user_id = p_user AND m.status = 'active') $f$;

CREATE FUNCTION app.is_project_creator(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = app.org() AND p.created_by = app.uid()) $$;

-- Project totals for people who can see the project. Totals only: individual entries stay private.
CREATE FUNCTION app.project_tracked_seconds(p_project uuid, p_billable boolean DEFAULT NULL) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN app.can_view_project(p_project) AND app.is_internal() THEN
    (SELECT coalesce(sum(duration_seconds), 0) FROM time_entries
      WHERE project_id = p_project AND status = 'stopped' AND (p_billable IS NULL OR billable = p_billable)) END
$$;

CREATE FUNCTION app.task_tracked_seconds(p_task uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN app.is_internal() AND app.can_view_project(app.task_project(p_task)) THEN
    (SELECT coalesce(sum(duration_seconds), 0) FROM time_entries WHERE task_id = p_task AND status = 'stopped') END
$$;

CREATE FUNCTION app.project_task_counts(p_project uuid, OUT total int, OUT done int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int, count(*) FILTER (WHERE completed_at IS NOT NULL)::int
    FROM tasks WHERE project_id = p_project AND parent_id IS NULL AND app.can_view_project(p_project)
$$;

-- Project and task names shown next to time entries, for people allowed to see those entries
-- (approvers are not necessarily members of every project they approve time for).
CREATE FUNCTION app.time_labels(p_project uuid, p_task uuid, OUT project_name text, OUT task_title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.name, t.title
    FROM projects p LEFT JOIN tasks t ON t.id = p_task AND t.project_id = p.id
   WHERE p.id = p_project AND p.org_id = app.org() AND app.is_internal()
     AND (app.can_view_project(p.id) OR app.has_permission('time.approve') OR app.has_permission('time.view_all'))
$$;

-- Project-member rules: client members must hold the Client / Guest role, internal members must not.
CREATE FUNCTION app.check_project_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_client boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM member_roles WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND role_key = 'client') INTO v_client;
  IF v_client AND NEW.role <> 'client' THEN
    RAISE EXCEPTION 'Clients and guests can only be added to a project as clients.' USING ERRCODE = 'P0001', HINT = 'project_member_role';
  END IF;
  IF NOT v_client AND NEW.role = 'client' THEN
    RAISE EXCEPTION 'Only people with the Client / Guest role can be added as project clients.' USING ERRCODE = 'P0001', HINT = 'project_member_role';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_members_role BEFORE INSERT OR UPDATE ON project_members FOR EACH ROW EXECUTE FUNCTION app.check_project_member();

CREATE TRIGGER clients_touch BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO workpilot_app;

-- ---------------------------------------------------------------- privileges
GRANT SELECT, INSERT, UPDATE ON clients TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_members TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON project_favourites TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_columns TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_labels TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON task_assignees TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON task_label_links TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON task_comments TO workpilot_app;
GRANT SELECT, INSERT ON project_activity TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON timesheets TO workpilot_app;
GRANT SELECT, INSERT ON notifications TO workpilot_app;
GRANT UPDATE (read_at) ON notifications TO workpilot_app;

-- ---------------------------------------------------------------- row level security
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_favourites ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_label_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Clients (the companies): internal members read; client managers write. Client guests see the
-- client record of projects they belong to.
CREATE POLICY clients_read ON clients FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (app.is_internal() OR EXISTS (SELECT 1 FROM projects p WHERE p.client_id = clients.id AND app.can_view_project(p.id))));
CREATE POLICY clients_insert ON clients FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.has_permission('clients.manage'));
CREATE POLICY clients_update ON clients FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('clients.manage')) WITH CHECK (org_id = app.org());

CREATE POLICY projects_read ON projects FOR SELECT TO workpilot_app USING (app.can_view_project(id));
CREATE POLICY projects_insert ON projects FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.has_permission('projects.create') AND created_by = app.uid());
CREATE POLICY projects_update ON projects FOR UPDATE TO workpilot_app
  USING (app.can_manage_project(id)) WITH CHECK (org_id = app.org());
CREATE POLICY projects_delete ON projects FOR DELETE TO workpilot_app
  USING (org_id = app.org() AND app.has_role('owner'));

-- Clients see the other people on their projects (names), internal members see all members.
CREATE POLICY project_members_read ON project_members FOR SELECT TO workpilot_app USING (app.can_view_project(project_id));
CREATE POLICY project_members_insert ON project_members FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND (app.can_manage_project(project_id)
    -- The creator adds themselves as manager right after creating the project.
    OR (user_id = app.uid() AND role = 'manager' AND app.is_project_creator(project_id))));
CREATE POLICY project_members_update ON project_members FOR UPDATE TO workpilot_app
  USING (app.can_manage_project(project_id) OR user_id = app.uid()) WITH CHECK (org_id = app.org());
CREATE POLICY project_members_delete ON project_members FOR DELETE TO workpilot_app USING (app.can_manage_project(project_id));

-- Clients (and everyone) can see the names of people on their own projects.
CREATE POLICY users_read_project_peers ON users FOR SELECT TO workpilot_app
  USING (EXISTS (SELECT 1 FROM project_members mine JOIN project_members peer ON peer.project_id = mine.project_id
                  WHERE mine.user_id = app.uid() AND mine.org_id = app.org() AND peer.user_id = users.id));

CREATE POLICY favourites_own ON project_favourites FOR ALL TO workpilot_app
  USING (user_id = app.uid() AND org_id = app.org())
  WITH CHECK (user_id = app.uid() AND org_id = app.org() AND app.can_view_project(project_id));

CREATE POLICY columns_read ON board_columns FOR SELECT TO workpilot_app USING (app.can_view_tasks(project_id));
CREATE POLICY columns_write ON board_columns FOR ALL TO workpilot_app
  USING (app.can_manage_project(project_id)) WITH CHECK (org_id = app.org() AND app.can_manage_project(project_id));

CREATE POLICY labels_read ON task_labels FOR SELECT TO workpilot_app USING (app.can_view_tasks(project_id));
CREATE POLICY labels_write ON task_labels FOR ALL TO workpilot_app
  USING (app.can_work_on_project(project_id)) WITH CHECK (org_id = app.org() AND app.can_work_on_project(project_id));

CREATE POLICY tasks_read ON tasks FOR SELECT TO workpilot_app USING (app.can_view_tasks(project_id));
CREATE POLICY tasks_insert ON tasks FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.can_work_on_project(project_id) AND created_by = app.uid());
CREATE POLICY tasks_update ON tasks FOR UPDATE TO workpilot_app
  USING (app.can_work_on_project(project_id)) WITH CHECK (org_id = app.org() AND app.can_work_on_project(project_id));
CREATE POLICY tasks_delete ON tasks FOR DELETE TO workpilot_app USING (app.can_work_on_project(project_id));

CREATE POLICY assignees_read ON task_assignees FOR SELECT TO workpilot_app USING (app.can_view_tasks(app.task_project(task_id)));
CREATE POLICY assignees_write ON task_assignees FOR ALL TO workpilot_app
  USING (app.can_work_on_project(app.task_project(task_id)))
  WITH CHECK (org_id = app.org() AND app.can_work_on_project(app.task_project(task_id)));

CREATE POLICY label_links_read ON task_label_links FOR SELECT TO workpilot_app USING (app.can_view_tasks(app.task_project(task_id)));
CREATE POLICY label_links_write ON task_label_links FOR ALL TO workpilot_app
  USING (app.can_work_on_project(app.task_project(task_id)))
  WITH CHECK (org_id = app.org() AND app.can_work_on_project(app.task_project(task_id)));

CREATE POLICY task_comments_read ON task_comments FOR SELECT TO workpilot_app USING (app.can_view_tasks(app.task_project(task_id)));
CREATE POLICY task_comments_insert ON task_comments FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND author_id = app.uid() AND app.can_work_on_project(app.task_project(task_id)));
CREATE POLICY task_comments_update ON task_comments FOR UPDATE TO workpilot_app
  USING (author_id = app.uid() AND org_id = app.org()) WITH CHECK (author_id = app.uid());

CREATE POLICY activity_read ON project_activity FOR SELECT TO workpilot_app
  USING (app.can_view_project(project_id) AND (app.is_internal() OR client_visible));
CREATE POLICY activity_insert ON project_activity FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND actor_id = app.uid() AND app.can_view_project(project_id));

CREATE POLICY time_read ON time_entries FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND app.is_internal() AND app.can_view_time_entry(user_id, project_id));
CREATE POLICY time_insert ON time_entries FOR INSERT TO workpilot_app
  -- Moving an entry to another project is checked by the API (the person must work on it); past
  -- entries stay editable for linking to timesheets even after someone leaves a project.
  WITH CHECK (org_id = app.org() AND user_id = app.uid());
-- Only the person who tracked the time edits it; approvers decide on timesheets, never on entries.
CREATE POLICY time_update ON time_entries FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND user_id = app.uid())
  WITH CHECK (org_id = app.org() AND user_id = app.uid() AND app.can_work_on_project(project_id));
CREATE POLICY time_delete ON time_entries FOR DELETE TO workpilot_app USING (org_id = app.org() AND user_id = app.uid());

CREATE POLICY timesheets_read ON timesheets FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('time.approve') OR app.has_permission('time.view_all')));
CREATE POLICY timesheets_insert ON timesheets FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND user_id = app.uid() AND status = 'submitted');
-- Owners resubmit after rejection; approvers decide. Nobody decides on their own timesheet.
CREATE POLICY timesheets_update ON timesheets FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('time.approve')))
  WITH CHECK (org_id = app.org() AND (
    (user_id = app.uid() AND status = 'submitted' AND decided_by IS NULL)
    OR (user_id <> app.uid() AND app.has_permission('time.approve') AND decided_by = app.uid())));

-- Notifications: read your own; any member may notify another member of the same organisation.
CREATE POLICY notifications_read ON notifications FOR SELECT TO workpilot_app USING (user_id = app.uid() AND org_id = app.org());
CREATE POLICY notifications_insert ON notifications FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND actor_id = app.uid() AND app.is_active_member(user_id));
CREATE POLICY notifications_update ON notifications FOR UPDATE TO workpilot_app
  USING (user_id = app.uid() AND org_id = app.org()) WITH CHECK (user_id = app.uid());
