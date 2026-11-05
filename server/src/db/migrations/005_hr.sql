-- WorkPilot AI — Phase 5: departments, employee profiles (with sensitive details kept apart),
-- attendance check-in/check-out, leave types, leave requests and approvals, holiday calendars.
-- Payroll is out of scope; employee_profiles is the place a future payroll module would join.

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  head_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)
);

CREATE TABLE employee_profiles (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  department_id uuid,
  manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
  employee_code text CHECK (employee_code IS NULL OR length(employee_code) <= 40),
  employment_type text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern')),
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'probation', 'on_leave', 'notice', 'exited')),
  start_date date,
  work_location text CHECK (work_location IS NULL OR length(work_location) <= 120),
  work_phone text CHECK (work_phone IS NULL OR length(work_phone) <= 40),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, department_id) REFERENCES departments(org_id, id) ON DELETE SET NULL (department_id),
  CHECK (manager_id IS NULL OR manager_id <> user_id)
);
CREATE INDEX employee_profiles_manager_idx ON employee_profiles (org_id, manager_id);

-- Sensitive details: visible to the employee and to people with hr.view_sensitive only.
CREATE TABLE employee_private (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  date_of_birth date,
  personal_email text CHECK (personal_email IS NULL OR personal_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  personal_phone text CHECK (personal_phone IS NULL OR length(personal_phone) <= 40),
  address text CHECK (address IS NULL OR length(address) <= 500),
  emergency_contact_name text CHECK (emergency_contact_name IS NULL OR length(emergency_contact_name) <= 120),
  emergency_contact_phone text CHECK (emergency_contact_phone IS NULL OR length(emergency_contact_phone) <= 40),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);

-- HR's own notes about an employee: never visible to the employee.
CREATE TABLE employee_hr_notes (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notes text NOT NULL CHECK (length(notes) <= 4000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);

CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, holiday_date)
);

CREATE TABLE leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  annual_allowance_days numeric(5, 1) NOT NULL DEFAULT 0 CHECK (annual_allowance_days BETWEEN 0 AND 365),
  paid boolean NOT NULL DEFAULT true,
  color text NOT NULL DEFAULT 'blue' CHECK (color IN ('blue', 'green', 'amber', 'red', 'purple', 'grey')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)
);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  half_day boolean NOT NULL DEFAULT false,
  days numeric(5, 1) NOT NULL CHECK (days > 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (NOT half_day OR start_date = end_date),
  CHECK (decided_by IS NULL OR decided_by <> user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types(org_id, id),
  -- A person cannot have overlapping pending or approved leave.
  EXCLUDE USING gist (user_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('pending', 'approved'))
);
CREATE INDEX leave_requests_status_idx ON leave_requests (org_id, status, start_date);

CREATE TABLE attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  check_in_at timestamptz NOT NULL,
  check_out_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 500),
  corrected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, work_date),
  CHECK (check_out_at IS NULL OR check_out_at > check_in_at),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX attendance_date_idx ON attendance_records (org_id, work_date);

-- Default leave types for every organisation, existing and new.
CREATE FUNCTION app.seed_leave_types() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO leave_types (org_id, name, annual_allowance_days, paid, color) VALUES
    (NEW.id, 'Annual leave', 18, true, 'blue'),
    (NEW.id, 'Sick leave', 12, true, 'red'),
    (NEW.id, 'Casual leave', 6, true, 'green'),
    (NEW.id, 'Unpaid leave', 0, false, 'grey')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER organizations_seed_leave AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION app.seed_leave_types();
INSERT INTO leave_types (org_id, name, annual_allowance_days, paid, color)
SELECT o.id, t.name, t.days, t.paid, t.color FROM organizations o
 CROSS JOIN (VALUES ('Annual leave', 18, true, 'blue'), ('Sick leave', 12, true, 'red'), ('Casual leave', 6, true, 'green'), ('Unpaid leave', 0, false, 'grey')) AS t(name, days, paid, color)
ON CONFLICT DO NOTHING;

-- Whether the current user manages `p_user` (reporting manager or department head).
CREATE FUNCTION app.manages(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM employee_profiles e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.org_id = app.org() AND e.user_id = p_user AND p_user <> app.uid()
       AND (e.manager_id = app.uid() OR d.head_id = app.uid()))
$$;

-- Leave decisions: approvers or the person's manager; never your own. Owners of a request may
-- only cancel it while it is pending or approved and has not started.
CREATE FUNCTION app.guard_leave_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user <> 'workpilot_app' THEN RETURN NEW; END IF;
  IF (NEW.user_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, NEW.half_day, NEW.days, NEW.reason)
     IS DISTINCT FROM (OLD.user_id, OLD.leave_type_id, OLD.start_date, OLD.end_date, OLD.half_day, OLD.days, OLD.reason) THEN
    RAISE EXCEPTION 'A leave request cannot be edited. Cancel it and make a new one.' USING ERRCODE = 'P0001', HINT = 'leave_immutable';
  END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NEW.status = 'cancelled' THEN
    IF OLD.user_id <> app.uid() OR OLD.status NOT IN ('pending', 'approved') OR (OLD.status = 'approved' AND OLD.start_date <= (now() AT TIME ZONE (SELECT timezone FROM organizations WHERE id = OLD.org_id))::date) THEN
      RAISE EXCEPTION 'Only the requester can cancel leave, and only before it starts.' USING ERRCODE = 'P0001', HINT = 'leave_cancel';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Only pending requests can be approved or rejected.' USING ERRCODE = 'P0001', HINT = 'leave_state';
  END IF;
  IF OLD.user_id = app.uid() OR NOT (app.has_permission('leave.approve') OR app.manages(OLD.user_id)) THEN
    RAISE EXCEPTION 'You cannot decide on this leave request.' USING ERRCODE = '42501';
  END IF;
  NEW.decided_by := app.uid();
  NEW.decided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER leave_requests_guard BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION app.guard_leave_update();

CREATE TRIGGER employee_profiles_touch BEFORE UPDATE ON employee_profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER employee_private_touch BEFORE UPDATE ON employee_private FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO workpilot_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON departments TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON employee_profiles TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON employee_private TO workpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON employee_hr_notes TO workpilot_app;
GRANT SELECT, INSERT, UPDATE ON leave_types TO workpilot_app;
GRANT SELECT, INSERT ON leave_requests TO workpilot_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON leave_requests TO workpilot_app;
GRANT SELECT, INSERT ON attendance_records TO workpilot_app;
GRANT UPDATE (check_in_at, check_out_at, note, corrected_by) ON attendance_records TO workpilot_app;

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_hr_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY departments_read ON departments FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.is_internal());
CREATE POLICY departments_write ON departments FOR ALL TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.manage')) WITH CHECK (org_id = app.org() AND app.has_permission('hr.manage'));

CREATE POLICY profiles_read ON employee_profiles FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.is_internal());
CREATE POLICY profiles_write ON employee_profiles FOR INSERT TO workpilot_app WITH CHECK (org_id = app.org() AND app.has_permission('hr.manage'));
CREATE POLICY profiles_update ON employee_profiles FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.manage')) WITH CHECK (org_id = app.org());

CREATE POLICY private_read ON employee_private FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('hr.view_sensitive')));
CREATE POLICY private_insert ON employee_private FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('hr.manage')));
CREATE POLICY private_update ON employee_private FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('hr.manage'))) WITH CHECK (org_id = app.org());

CREATE POLICY hr_notes_read ON employee_hr_notes FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.view_sensitive') AND user_id <> app.uid());
CREATE POLICY hr_notes_write ON employee_hr_notes FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.has_permission('hr.manage') AND user_id <> app.uid());
CREATE POLICY hr_notes_update ON employee_hr_notes FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.manage') AND user_id <> app.uid()) WITH CHECK (org_id = app.org());

CREATE POLICY holidays_read ON holidays FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.is_internal());
CREATE POLICY holidays_write ON holidays FOR ALL TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.manage')) WITH CHECK (org_id = app.org() AND app.has_permission('hr.manage'));

CREATE POLICY leave_types_read ON leave_types FOR SELECT TO workpilot_app USING (org_id = app.org() AND app.is_internal());
CREATE POLICY leave_types_write ON leave_types FOR ALL TO workpilot_app
  USING (org_id = app.org() AND app.has_permission('hr.manage')) WITH CHECK (org_id = app.org() AND app.has_permission('hr.manage'));

CREATE POLICY leave_read ON leave_requests FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('leave.approve') OR app.has_permission('hr.view_sensitive') OR app.manages(user_id)));
CREATE POLICY leave_insert ON leave_requests FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND user_id = app.uid() AND app.is_internal() AND status = 'pending' AND decided_by IS NULL);
CREATE POLICY leave_update ON leave_requests FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('leave.approve') OR app.manages(user_id)))
  WITH CHECK (org_id = app.org());

CREATE POLICY attendance_read ON attendance_records FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('hr.view_sensitive') OR app.manages(user_id)));
CREATE POLICY attendance_insert ON attendance_records FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND app.is_internal() AND (user_id = app.uid() OR app.has_permission('hr.manage')));
CREATE POLICY attendance_update ON attendance_records FOR UPDATE TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR app.has_permission('hr.manage'))) WITH CHECK (org_id = app.org());
