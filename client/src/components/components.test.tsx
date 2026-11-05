import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsFor, type RoleKey, type SessionDTO } from '@workpilot/shared';
import { RolePicker } from './RoleBadges';
import { ErrorPanel } from './ErrorPanel';
import { ApiError } from '../lib/api';
import { visibleNav } from '../lib/nav';

function Picker({ initial, allowOwner = true }: { initial: RoleKey[]; allowOwner?: boolean }) {
  const [v, setV] = useState<RoleKey[]>(initial);
  return (
    <>
      <RolePicker value={v} onChange={setV} allowOwner={allowOwner} />
      <output data-testid="value">{v.join(',')}</output>
    </>
  );
}

describe('RolePicker', () => {
  it('keeps Client / Guest exclusive of internal roles', async () => {
    render(<Picker initial={['member']} />);
    await userEvent.click(screen.getByLabelText(/Project Manager/));
    expect(screen.getByTestId('value').textContent).toBe('member,project_manager');
    await userEvent.click(screen.getByLabelText(/Client \/ Guest/));
    expect(screen.getByTestId('value').textContent).toBe('client');
    await userEvent.click(screen.getByLabelText(/Team Member/));
    expect(screen.getByTestId('value').textContent).toBe('member');
  });

  it('locks the Owner role when the user may not grant it', () => {
    render(<Picker initial={['member']} allowOwner={false} />);
    expect(screen.getByLabelText(/Organisation Owner/)).toBeDisabled();
    expect(screen.getByText('Only an owner can grant this role.')).toBeInTheDocument();
  });
});

describe('ErrorPanel', () => {
  it('shows the category title, message, reference and a retry for retryable errors', async () => {
    let retried = false;
    render(<ErrorPanel error={new ApiError(503, 'DATABASE_ERROR', 'We could not reach the database.', true, 'abc-123-def')} operation="Loading members" onRetry={() => (retried = true)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Loading members');
    expect(screen.getByText('Reference: abc-123-def')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retried).toBe(true);
  });

  it('offers no retry for permission errors', () => {
    render(<ErrorPanel error={new ApiError(403, 'AUTHORIZATION_ERROR', 'No.', false, 'r1')} onRetry={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('navigation', () => {
  const session = (roles: RoleKey[], admin = false) =>
    ({ roles, permissions: permissionsFor(roles), user: { isPlatformAdmin: admin } }) as unknown as SessionDTO;

  it('gives clients only the shared modules', () => {
    expect(visibleNav(session(['client'])).map((n) => n.label)).toEqual(['Dashboard', 'Projects', 'Team Chat', 'Settings']);
  });
  it('gives internal members everything except platform admin', () => {
    const labels = visibleNav(session(['member'])).map((n) => n.label);
    expect(labels).toEqual(['Dashboard', 'My Tasks', 'Projects', 'Time Tracker', 'Team Chat', 'People & HR', 'Attendance & Leave', 'Clients', 'Reports', 'AI Assistant', 'Settings']);
    expect(visibleNav(session(['owner'], true)).at(-1)?.label).toBe('Platform admin');
  });
});
