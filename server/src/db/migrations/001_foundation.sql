-- WorkPilot AI — Phase 1 foundation: organisations, users, memberships, roles and permissions,
-- invitations, sessions and the audit log, with Row Level Security.
--
-- Security model
--   * The API runs ordinary requests on a restricted login role, `workpilot_app`, which is not a
--     superuser, does not bypass RLS and does not own these tables, so every policy below applies.
--   * For each request the API opens a transaction and sets `app.user_id` and `app.org_id` with
--     set_config(..., true). `app.org()` only returns the organisation when the user is an
--     active member of it, so a forged or stale org id yields nothing.
--   * Secrets (password hashes, session and reset tokens) live in tables the app role has no
--     privileges on at all. Only the authentication service, which uses the owner connection,
--     can read them.
--   * All timestamps are timestamptz (stored in UTC). Each organisation has an IANA timezone for
--     display and reporting.

-- ---------------------------------------------------------------- application role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workpilot_app') THEN
    -- The operator sets LOGIN and a password (scripts/dev-db.mjs does it in development).
    CREATE ROLE workpilot_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO workpilot_app;
GRANT USAGE ON SCHEMA public TO workpilot_app;

-- ---------------------------------------------------------------- reference data: roles & permissions
CREATE TABLE roles (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  is_external boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL
);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_key text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

INSERT INTO roles (key, name, description, is_external, sort_order) VALUES
  ('owner', 'Organisation Owner', 'Full control of the organisation, its members and settings.', false, 1),
  ('hr_manager', 'HR Manager', 'Manages people, attendance and leave; can invite members.', false, 2),
  ('project_manager', 'Project Manager', 'Creates and runs projects, approves project time and invites clients.', false, 3),
  ('finance_manager', 'Finance Manager', 'Sees budgets, billable time and organisation-wide reports.', false, 4),
  ('member', 'Team Member', 'Works on assigned projects and tasks, tracks time and requests leave.', false, 5),
  ('client', 'Client / Guest', 'External person who sees only the projects and updates shared with them.', true, 6);

INSERT INTO permissions (key, description) VALUES
  ('org.manage', 'Change organisation name, timezone and settings'),
  ('members.view', 'See the member directory'),
  ('members.invite', 'Invite people to the organisation'),
  ('members.manage_roles', 'Change members’ roles (including granting Owner)'),
  ('members.deactivate', 'Deactivate and reactivate members'),
  ('audit.view', 'Read the organisation audit log'),
  ('projects.create', 'Create projects'),
  ('projects.view_all', 'See every project, not only assigned ones'),
  ('clients.manage', 'Manage clients and invite client guests to projects'),
  ('time.approve', 'Approve or reject timesheets'),
  ('time.view_all', 'See everyone’s time entries'),
  ('hr.view_sensitive', 'See sensitive employee records'),
  ('hr.manage', 'Manage employee records, departments and holidays'),
  ('leave.approve', 'Approve or reject leave requests'),
  ('finance.view', 'See budgets and billable amounts'),
  ('reports.view_all', 'See organisation-wide reports'),
  ('ai.use', 'Use the AI assistant');

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'owner', key FROM permissions;
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('hr_manager', 'members.view'), ('hr_manager', 'members.invite'), ('hr_manager', 'members.deactivate'),
  ('hr_manager', 'hr.view_sensitive'), ('hr_manager', 'hr.manage'), ('hr_manager', 'leave.approve'), ('hr_manager', 'ai.use'),
  ('project_manager', 'members.view'), ('project_manager', 'projects.create'), ('project_manager', 'clients.manage'),
  ('project_manager', 'time.approve'), ('project_manager', 'ai.use'),
  ('finance_manager', 'members.view'), ('finance_manager', 'finance.view'), ('finance_manager', 'time.view_all'),
  ('finance_manager', 'reports.view_all'), ('finance_manager', 'ai.use'),
  ('member', 'members.view'), ('member', 'ai.use');

-- ---------------------------------------------------------------- organisations and users
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- User profiles. Credentials are kept separately in user_credentials.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' AND length(email) <= 254),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  job_title text CHECK (job_title IS NULL OR length(job_title) <= 120),
  is_platform_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

ALTER TABLE organizations ADD CONSTRAINT organizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id text PRIMARY KEY,                       -- sha256 of the cookie token; the token itself is never stored
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  csrf_token text NOT NULL,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- ---------------------------------------------------------------- memberships and roles
CREATE TABLE organization_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE member_roles (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_key text NOT NULL REFERENCES roles(key),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, role_key),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role_idx ON member_roles (org_id, role_key);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  roles text[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 6),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK (NOT ('client' = ANY (roles) AND cardinality(roles) > 1)),
  CHECK (roles <@ ARRAY['owner', 'hr_manager', 'project_manager', 'finance_manager', 'member', 'client']::text[])
);
-- At most one open invitation per address per organisation.
CREATE UNIQUE INDEX invitations_open_key ON invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  entity_type text,
  entity_id text,
  summary text NOT NULL CHECK (length(summary) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (org_id, created_at DESC);

-- ---------------------------------------------------------------- request context helpers
-- SECURITY DEFINER so policies can consult memberships without recursing through their own RLS.

CREATE FUNCTION app.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.org() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.org_id
    FROM organization_members m
    JOIN organizations o ON o.id = m.org_id
    JOIN users u ON u.id = m.user_id
   WHERE m.org_id = nullif(current_setting('app.org_id', true), '')::uuid
     AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
     AND m.status = 'active' AND o.status = 'active' AND u.status = 'active'
$$;

CREATE FUNCTION app.my_org_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.org_id FROM organization_members m
   WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'
$$;

CREATE FUNCTION app.has_role(p_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM member_roles r
     WHERE r.org_id = app.org() AND r.user_id = app.uid() AND r.role_key = p_role)
$$;

CREATE FUNCTION app.has_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM member_roles r
      JOIN role_permissions rp ON rp.role_key = r.role_key
     WHERE r.org_id = app.org() AND r.user_id = app.uid() AND rp.permission_key = p_permission)
$$;

-- True for members holding at least one internal (non-client) role in the active organisation.
CREATE FUNCTION app.is_internal() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM member_roles r JOIN roles ro ON ro.key = r.role_key
     WHERE r.org_id = app.org() AND r.user_id = app.uid() AND NOT ro.is_external)
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO workpilot_app;

-- ---------------------------------------------------------------- integrity triggers
-- These run for every connection, including the owner connection used by sign-up and
-- invitation acceptance, so the rules cannot be bypassed by any code path.

CREATE FUNCTION app.check_role_combination() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  new_external boolean;
BEGIN
  SELECT is_external INTO new_external FROM roles WHERE key = NEW.role_key;
  IF EXISTS (
    SELECT 1 FROM member_roles r JOIN roles ro ON ro.key = r.role_key
     WHERE r.org_id = NEW.org_id AND r.user_id = NEW.user_id AND r.role_key <> NEW.role_key
       AND ro.is_external <> new_external) THEN
    RAISE EXCEPTION 'Client / Guest cannot be combined with internal roles.' USING ERRCODE = 'P0001', HINT = 'role_combination';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER member_roles_combination BEFORE INSERT OR UPDATE ON member_roles
  FOR EACH ROW EXECUTE FUNCTION app.check_role_combination();

-- An organisation must always keep at least one active owner.
CREATE FUNCTION app.protect_last_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
  v_user uuid;
BEGIN
  IF TG_TABLE_NAME = 'member_roles' THEN
    IF OLD.role_key <> 'owner' THEN RETURN OLD; END IF;
    v_org := OLD.org_id; v_user := OLD.user_id;
  ELSE
    IF NOT (OLD.status = 'active' AND NEW.status <> 'active') THEN RETURN NEW; END IF;
    v_org := OLD.org_id; v_user := OLD.user_id;
    IF NOT EXISTS (SELECT 1 FROM member_roles WHERE org_id = v_org AND user_id = v_user AND role_key = 'owner') THEN RETURN NEW; END IF;
  END IF;
  -- Deleting the whole organisation cascades; nothing to protect then.
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM member_roles r JOIN organization_members m ON m.org_id = r.org_id AND m.user_id = r.user_id
     WHERE r.org_id = v_org AND r.role_key = 'owner' AND r.user_id <> v_user AND m.status = 'active') THEN
    RAISE EXCEPTION 'An organisation must keep at least one active owner.' USING ERRCODE = 'P0001', HINT = 'last_owner';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER member_roles_last_owner BEFORE DELETE ON member_roles
  FOR EACH ROW EXECUTE FUNCTION app.protect_last_owner();
CREATE TRIGGER organization_members_last_owner BEFORE UPDATE OF status ON organization_members
  FOR EACH ROW EXECUTE FUNCTION app.protect_last_owner();

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------- privileges for the app role
GRANT SELECT ON roles, permissions, role_permissions TO workpilot_app;
GRANT SELECT ON organizations TO workpilot_app;
GRANT UPDATE (name, timezone) ON organizations TO workpilot_app;
GRANT SELECT ON users TO workpilot_app;
GRANT UPDATE (full_name, job_title) ON users TO workpilot_app;
GRANT SELECT ON organization_members TO workpilot_app;
GRANT UPDATE (status, deactivated_at) ON organization_members TO workpilot_app;
GRANT SELECT, INSERT, DELETE ON member_roles TO workpilot_app;
GRANT SELECT, INSERT ON invitations TO workpilot_app;
GRANT UPDATE (revoked_at) ON invitations TO workpilot_app;
GRANT SELECT, INSERT ON audit_logs TO workpilot_app;
-- Deliberately no privileges on user_credentials, sessions or password_resets.

-- ---------------------------------------------------------------- row level security
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_read ON roles FOR SELECT TO workpilot_app USING (true);
CREATE POLICY permissions_read ON permissions FOR SELECT TO workpilot_app USING (true);
CREATE POLICY role_permissions_read ON role_permissions FOR SELECT TO workpilot_app USING (true);

-- Organisations: a user sees the organisations they actively belong to (for the switcher).
CREATE POLICY organizations_read ON organizations FOR SELECT TO workpilot_app
  USING (id IN (SELECT app.my_org_ids()));
CREATE POLICY organizations_update ON organizations FOR UPDATE TO workpilot_app
  USING (id = app.org() AND app.has_permission('org.manage'))
  WITH CHECK (id = app.org());

-- Users: yourself, plus (for internal members) other members of the active organisation.
-- Clients see only themselves here; project-level visibility is added with projects.
CREATE POLICY users_read ON users FOR SELECT TO workpilot_app
  USING (
    id = app.uid()
    OR (app.is_internal() AND EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = users.id AND m.org_id = app.org()))
  );
CREATE POLICY users_update_self ON users FOR UPDATE TO workpilot_app
  USING (id = app.uid()) WITH CHECK (id = app.uid());

CREATE POLICY members_read ON organization_members FOR SELECT TO workpilot_app
  USING (
    user_id = app.uid()
    OR (org_id = app.org() AND app.is_internal())
  );
CREATE POLICY members_update ON organization_members FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('members.deactivate'))
  WITH CHECK (org_id = app.org());

CREATE POLICY member_roles_read ON member_roles FOR SELECT TO workpilot_app
  USING (
    user_id = app.uid()
    OR (org_id = app.org() AND app.is_internal())
  );
CREATE POLICY member_roles_insert ON member_roles FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.has_permission('members.manage_roles'));
CREATE POLICY member_roles_delete ON member_roles FOR DELETE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('members.manage_roles'));

-- Invitations: only people who may invite. Inviting an owner needs the role-management permission.
CREATE POLICY invitations_read ON invitations FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('members.invite'));
CREATE POLICY invitations_insert ON invitations FOR INSERT TO workpilot_app
  WITH CHECK (
    org_id = app.org() AND app.has_permission('members.invite') AND invited_by = app.uid()
    AND (NOT ('owner' = ANY (roles)) OR app.has_permission('members.manage_roles'))
  );
CREATE POLICY invitations_revoke ON invitations FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('members.invite'))
  WITH CHECK (org_id = app.org());

CREATE POLICY audit_read ON audit_logs FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('audit.view'));
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND actor_id = app.uid());
