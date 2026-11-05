import { useId } from 'react';
import { ROLES, ROLE_KEYS, roleSetProblem, type RoleKey } from '@workpilot/shared';
import { Badge } from './ui';

export function RoleBadges({ roles }: { roles: RoleKey[] }) {
  return (
    <span className="badges">
      {roles.map((r) => (
        <Badge key={r} tone={r === 'owner' ? 'primary' : r === 'client' ? 'warning' : 'neutral'}>
          {ROLES[r].name}
        </Badge>
      ))}
    </span>
  );
}

/** Checkbox group for choosing roles. Client / Guest is exclusive; Owner can be locked. */
export function RolePicker({ value, onChange, allowOwner, error }: { value: RoleKey[]; onChange: (r: RoleKey[]) => void; allowOwner: boolean; error?: string }) {
  const id = useId();
  const problem = error ?? (value.length ? roleSetProblem(value) : null) ?? undefined;
  const toggle = (r: RoleKey, on: boolean) => {
    if (!on) return onChange(value.filter((x) => x !== r));
    // Choosing Client clears internal roles and vice versa, so the set is always valid.
    if (r === 'client') return onChange(['client']);
    return onChange([...value.filter((x) => x !== 'client'), r]);
  };
  return (
    <fieldset className="fieldset" aria-describedby={problem ? `${id}-error` : `${id}-hint`}>
      <legend className="field-label">Roles</legend>
      <p id={`${id}-hint`} className="field-hint">
        Internal roles can be combined. Client / Guest is for external people and cannot be combined.
      </p>
      <div className="role-options">
        {ROLE_KEYS.map((r) => {
          const disabled = r === 'owner' && !allowOwner;
          return (
            <label key={r} className={`role-option${disabled ? ' role-option-disabled' : ''}`}>
              <input type="checkbox" checked={value.includes(r)} disabled={disabled} onChange={(e) => toggle(r, e.target.checked)} />
              <span>
                <span className="role-option-name">{ROLES[r].name}</span>
                <span className="role-option-desc">{disabled ? 'Only an owner can grant this role.' : ROLES[r].description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {problem && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
