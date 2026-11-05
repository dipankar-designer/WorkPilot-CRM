-- WorkPilot AI — fuller leave applications: half-day sessions at either end (session 1 = first
-- half, session 2 = second half), a chosen approver ("applying to"), people kept informed
-- ("CC to"), contact details while away, and supporting documents.
--
-- The approver and CC'd people may read the request (and its attachments); they gain no other
-- access. Decisions stay with people who hold leave.approve or manage the requester (trigger
-- from 005).

ALTER TABLE leave_requests
  ADD COLUMN start_session smallint NOT NULL DEFAULT 1 CHECK (start_session IN (1, 2)),
  ADD COLUMN end_session smallint NOT NULL DEFAULT 2 CHECK (end_session IN (1, 2)),
  ADD COLUMN approver_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN cc_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(cc_user_ids) <= 20),
  ADD COLUMN contact_details text CHECK (contact_details IS NULL OR length(contact_details) <= 200);

-- Earlier half-day requests were first-half only.
UPDATE leave_requests SET end_session = 1 WHERE half_day;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_session_order CHECK (start_date < end_date OR start_session <= end_session);
CREATE INDEX leave_requests_approver_idx ON leave_requests (approver_id) WHERE status = 'pending';

CREATE FUNCTION app.can_see_leave(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $f$
  SELECT EXISTS (
    SELECT 1 FROM leave_requests l
     WHERE l.id = p_request AND l.org_id = app.org()
       AND (l.user_id = app.uid() OR l.approver_id = app.uid() OR app.uid() = ANY (l.cc_user_ids)
            OR app.has_permission('leave.approve') OR app.has_permission('hr.view_sensitive') OR app.manages(l.user_id)))
$f$;
REVOKE ALL ON FUNCTION app.can_see_leave(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_see_leave(uuid) TO workpilot_app;

DROP POLICY leave_read ON leave_requests;
CREATE POLICY leave_read ON leave_requests FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND (user_id = app.uid() OR approver_id = app.uid() OR app.uid() = ANY (cc_user_ids)
    OR app.has_permission('leave.approve') OR app.has_permission('hr.view_sensitive') OR app.manages(user_id)));

-- Supporting documents for a leave request live in `files` like every other upload.
ALTER TABLE files ADD COLUMN leave_request_id uuid REFERENCES leave_requests(id) ON DELETE CASCADE;
DO $f$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'files'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%project_id IS NOT NULL%channel_id IS NOT NULL%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE files DROP CONSTRAINT %I', c); END IF;
END
$f$;
ALTER TABLE files ADD CONSTRAINT files_has_owner CHECK (project_id IS NOT NULL OR channel_id IS NOT NULL OR leave_request_id IS NOT NULL);
CREATE INDEX files_leave_idx ON files (leave_request_id);

CREATE POLICY files_leave_read ON files FOR SELECT TO workpilot_app
  USING (org_id = app.org() AND leave_request_id IS NOT NULL AND app.can_see_leave(leave_request_id));
CREATE POLICY files_leave_insert ON files FOR INSERT TO workpilot_app
  WITH CHECK (org_id = app.org() AND uploaded_by = app.uid() AND leave_request_id IS NOT NULL AND project_id IS NULL AND channel_id IS NULL
    AND EXISTS (SELECT 1 FROM leave_requests l WHERE l.id = leave_request_id AND l.user_id = app.uid() AND l.status = 'pending'));
