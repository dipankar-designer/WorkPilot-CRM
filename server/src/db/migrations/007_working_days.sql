-- WorkPilot AI — each organisation's working week (ISO weekdays: 1 = Monday … 7 = Sunday).
-- Leave counts only working days. The default is all seven days, so leave can be requested for
-- any day; organisations that do not work weekends can untick Saturday and Sunday in Settings.

ALTER TABLE organizations
  ADD COLUMN working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'
    CHECK (cardinality(working_days) BETWEEN 1 AND 7 AND working_days <@ '{1,2,3,4,5,6,7}'::smallint[]);

GRANT UPDATE (working_days) ON organizations TO workpilot_app;
