-- WorkPilot AI — the leave details added in 008 (sessions, approver, CC and contact details) are part of the
-- request, so they become immutable like its dates: change them by cancelling and applying again.

CREATE OR REPLACE FUNCTION app.guard_leave_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user <> 'workpilot_app' THEN RETURN NEW; END IF;
  IF (NEW.user_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, NEW.half_day, NEW.days, NEW.reason,
      NEW.start_session, NEW.end_session, NEW.approver_id, NEW.cc_user_ids, NEW.contact_details)
     IS DISTINCT FROM (OLD.user_id, OLD.leave_type_id, OLD.start_date, OLD.end_date, OLD.half_day, OLD.days, OLD.reason,
      OLD.start_session, OLD.end_session, OLD.approver_id, OLD.cc_user_ids, OLD.contact_details) THEN
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
