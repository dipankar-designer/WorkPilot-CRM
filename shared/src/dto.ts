// Shapes returned by the API. Timestamps are ISO-8601 strings in UTC; the client formats them
// in the organisation's timezone.

import type { PermissionKey, RoleKey } from './roles.js';

export interface UserDTO {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
}

export interface OrgDTO {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** Working week as ISO weekdays (1 = Monday … 7 = Sunday). Leave counts only these days. */
  workingDays: number[];
}

export interface MembershipDTO extends OrgDTO {
  roles: RoleKey[];
}

export interface SessionDTO {
  user: UserDTO;
  /** The active organisation; null when the user has no active membership. */
  org: OrgDTO | null;
  roles: RoleKey[];
  permissions: PermissionKey[];
  memberships: MembershipDTO[];
  csrfToken: string;
  features: { emailDelivery: 'smtp' | 'outbox' | 'none'; signupsEnabled: boolean };
}

export type MemberStatus = 'active' | 'deactivated';

export interface MemberDTO {
  userId: string;
  fullName: string;
  email: string;
  jobTitle: string | null;
  status: MemberStatus;
  roles: RoleKey[];
  joinedAt: string;
}

export interface InvitationDTO {
  id: string;
  email: string;
  roles: RoleKey[];
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface InvitationCreatedDTO {
  invitation: InvitationDTO;
  /** Only returned when the email could not be sent by SMTP, so the inviter can share the link. */
  acceptUrl: string | null;
  delivery: 'smtp' | 'outbox' | 'none';
}

export interface InvitationPreviewDTO {
  orgName: string;
  email: string;
  roles: RoleKey[];
  invitedBy: string | null;
  expiresAt: string;
  status: InvitationDTO['status'];
  accountExists: boolean;
}

export interface AuditEntryDTO {
  id: number;
  action: string;
  summary: string;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DashboardSummaryDTO {
  activeMembers: number;
  deactivatedMembers: number;
  clientGuests: number;
  /** Null when the viewer may not see invitations. */
  pendingInvitations: number | null;
  /** Null when the viewer may not read the audit log. */
  recentActivity: AuditEntryDTO[] | null;
}

export interface AdminOrgDTO {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  activeMembers: number;
  createdAt: string;
}
