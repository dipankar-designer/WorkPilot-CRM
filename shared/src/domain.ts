// Data shapes for projects, tasks, time, feed, files, chat, HR, reports and the AI assistant.
// Dates without a time ("2026-10-27") are calendar dates in the organisation's timezone;
// timestamps are ISO-8601 UTC.

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

export const LABEL_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'grey'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export type ProjectRole = 'manager' | 'member' | 'client';

export interface PersonRef {
  id: string;
  name: string;
}

export interface ClientDTO {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  notes: string | null;
  archived: boolean;
  projectCount: number;
  createdAt: string;
}

export interface ProjectSummaryDTO {
  id: string;
  name: string;
  status: ProjectStatus;
  favourite: boolean;
  /** Feed posts since the viewer last opened the feed, plus unread project chat messages. */
  unread: number;
}

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  client: { id: string; name: string } | null;
  manager: PersonRef | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  deadline: string | null;
  estimatedHours: number | null;
  /** Null when the viewer may not see budgets. */
  budget: number | null;
  currency: string;
  clientTaskAccess: boolean;
  clientsCanPost: boolean;
  favourite: boolean;
  myRole: ProjectRole | null;
  canManage: boolean;
  canWork: boolean;
  taskCount: number;
  doneCount: number;
  /** Tracked hours; null for viewers who may not see project time (clients). */
  trackedHours: number | null;
  memberCount: number;
  archived: boolean;
  createdAt: string;
}

export interface ProjectMemberDTO {
  userId: string;
  name: string;
  email: string | null;
  role: ProjectRole;
  addedAt: string;
}

export interface LabelDTO {
  id: string;
  name: string;
  color: LabelColor;
}

export interface ColumnDTO {
  id: string;
  name: string;
  position: number;
  isDone: boolean;
}

export interface TaskCardDTO {
  id: string;
  projectId: string;
  projectName?: string;
  columnId: string;
  columnName?: string;
  parentId: string | null;
  title: string;
  priority: Priority;
  dueDate: string | null;
  estimatedHours: number | null;
  position: number;
  completedAt: string | null;
  assignees: PersonRef[];
  labels: LabelDTO[];
  subtaskCount: number;
  subtaskDone: number;
  commentCount: number;
  attachmentCount: number;
}

export interface BoardDTO {
  columns: ColumnDTO[];
  tasks: TaskCardDTO[];
  labels: LabelDTO[];
  members: ProjectMemberDTO[];
  canWork: boolean;
  canManage: boolean;
}

export interface CommentDTO {
  id: string;
  author: PersonRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface ActivityDTO {
  id: number;
  kind: string;
  summary: string;
  actor: PersonRef | null;
  taskId: string | null;
  createdAt: string;
}

export interface FileDTO {
  id: string;
  kind: 'file' | 'link';
  category: FileCategory;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  visibility: Visibility;
  uploadedBy: PersonRef | null;
  createdAt: string;
  projectId: string | null;
  postId: string | null;
  taskId: string | null;
  messageId: string | null;
  leaveRequestId?: string | null;
}

export interface TaskDetailDTO extends TaskCardDTO {
  description: string | null;
  createdBy: PersonRef | null;
  createdAt: string;
  updatedAt: string;
  subtasks: TaskCardDTO[];
  comments: CommentDTO[];
  activity: ActivityDTO[];
  files: FileDTO[];
  trackedSeconds: number | null;
}

// ---------------------------------------------------------------- time

export type TimeEntryStatus = 'running' | 'paused' | 'stopped';

export interface TimeEntryDTO {
  id: string;
  user: PersonRef;
  project: PersonRef;
  task: PersonRef | null;
  description: string | null;
  billable: boolean;
  source: 'timer' | 'manual';
  status: TimeEntryStatus;
  startedAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  pausedSeconds: number;
  /** Elapsed working seconds, computed by the server at `serverTime`. */
  seconds: number;
  locked: boolean;
  timesheetStatus: TimesheetStatus | null;
}

export interface TimerStateDTO {
  entry: TimeEntryDTO | null;
  serverTime: string;
  todaySeconds: number;
}

export type TimesheetStatus = 'submitted' | 'approved' | 'rejected';

export interface TimesheetDTO {
  id: string;
  user: PersonRef;
  weekStart: string;
  status: TimesheetStatus;
  totalSeconds: number;
  billableSeconds: number;
  submittedAt: string;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface WeekDTO {
  weekStart: string;
  entries: TimeEntryDTO[];
  totalSeconds: number;
  billableSeconds: number;
  timesheet: TimesheetDTO | null;
}

// ---------------------------------------------------------------- feed and files

export type Visibility = 'internal' | 'client';
export const FEED_KINDS = ['update', 'announcement', 'question', 'progress'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_KIND_LABELS: Record<FeedKind, string> = { update: 'Update', announcement: 'Announcement', question: 'Question', progress: 'Progress' };
export const REACTIONS = ['👍', '🎉', '❤️', '👀', '✅'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const FILE_CATEGORIES = ['image', 'document', 'pdf', 'design', 'brief', 'link', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface FeedCommentDTO extends CommentDTO {
  parentId: string | null;
  canEdit: boolean;
}

export interface FeedPostDTO {
  id: string;
  projectId: string;
  author: PersonRef | null;
  kind: FeedKind;
  visibility: Visibility;
  body: string;
  linkUrl: string | null;
  pinned: boolean;
  createdAt: string;
  editedAt: string | null;
  reactions: { emoji: Reaction; count: number; mine: boolean }[];
  comments: FeedCommentDTO[];
  files: FileDTO[];
  canEdit: boolean;
  canPin: boolean;
}

// ---------------------------------------------------------------- chat and notifications

export type ChannelKind = 'direct' | 'group' | 'team' | 'project' | 'client';

export interface ChannelDTO {
  id: string;
  kind: ChannelKind;
  name: string;
  projectId: string | null;
  members: PersonRef[];
  unread: number;
  lastMessageAt: string | null;
  canManage: boolean;
}

export interface MessageDTO {
  id: string;
  seq: number;
  channelId: string;
  author: PersonRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  files: FileDTO[];
  /** People (other than the author) who have read this message. */
  readBy: PersonRef[];
}

export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  actor: PersonRef | null;
  read: boolean;
  createdAt: string;
}

/** Messages pushed over the realtime connection. Payloads carry ids; details are fetched over the API. */
export type RealtimeEvent =
  | { type: 'hello'; userId: string; orgId: string; online: string[] }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'typing'; channelId: string; userId: string; name: string }
  | { type: 'chat.message'; channelId: string; messageId: string }
  | { type: 'chat.updated'; channelId: string; messageId: string }
  | { type: 'chat.read'; channelId: string; userId: string; seq: number }
  | { type: 'notification'; notificationId: string }
  | { type: 'feed.changed'; projectId: string }
  | { type: 'board.changed'; projectId: string; taskId?: string }
  | { type: 'timer.changed' };

export type RealtimeClientMessage = { type: 'typing'; channelId: string } | { type: 'ping' };

// ---------------------------------------------------------------- HR

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', intern: 'Intern' };
export const EMPLOYMENT_STATUSES = ['active', 'probation', 'on_leave', 'notice', 'exited'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = { active: 'Active', probation: 'Probation', on_leave: 'On leave', notice: 'Notice period', exited: 'Exited' };

export interface DepartmentDTO {
  id: string;
  name: string;
  description: string | null;
  head: PersonRef | null;
  memberCount: number;
}

export interface EmployeeDTO {
  userId: string;
  name: string;
  email: string;
  jobTitle: string | null;
  department: { id: string; name: string } | null;
  manager: PersonRef | null;
  employeeCode: string | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  startDate: string | null;
  workLocation: string | null;
  workPhone: string | null;
  memberStatus: 'active' | 'deactivated';
}

export interface EmployeePrivateDTO {
  dateOfBirth: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}

export interface HolidayDTO {
  id: string;
  date: string;
  name: string;
}

export interface LeaveTypeDTO {
  id: string;
  name: string;
  annualAllowanceDays: number;
  paid: boolean;
  color: LabelColor;
  archived: boolean;
}

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequestDTO {
  id: string;
  user: PersonRef;
  leaveType: { id: string; name: string; color: LabelColor };
  startDate: string;
  endDate: string;
  halfDay: boolean;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  canDecide: boolean;
  canCancel: boolean;
  /** 1 = from the first half of the start day, 2 = from its second half. */
  startSession: LeaveSession;
  /** 1 = until the end of the first half of the last day, 2 = until the end of the day. */
  endSession: LeaveSession;
  approver: PersonRef | null;
  cc: PersonRef[];
  contactDetails: string | null;
  files: FileDTO[];
}

export type LeaveSession = 1 | 2;
export const LEAVE_SESSION_LABELS: Record<LeaveSession, string> = { 1: 'Session 1 (first half)', 2: 'Session 2 (second half)' };

/** File types accepted as supporting documents for leave. */
export const LEAVE_ATTACHMENT_TYPES = ['pdf', 'xls', 'xlsx', 'doc', 'docx', 'txt', 'ppt', 'pptx', 'gif', 'jpg', 'jpeg', 'png'] as const;

export interface LeaveApproverDTO extends PersonRef {
  /** Why this person can approve: the reporting manager, department head or HR/owner. */
  reason: 'manager' | 'department_head' | 'hr';
}

export interface LeavePreviewDTO {
  days: number;
  /** Balance of the chosen leave type for the start date's year (null without a type). */
  balance: LeaveBalanceDTO | null;
  /** Why these dates cannot be requested, if they cannot. */
  problem: string | null;
}

export interface LeaveBalanceDTO {
  leaveType: LeaveTypeDTO;
  allowance: number;
  taken: number;
  pending: number;
  remaining: number;
}

export interface AttendanceDTO {
  id: string;
  user: PersonRef;
  workDate: string;
  checkInAt: string;
  checkOutAt: string | null;
  seconds: number | null;
  note: string | null;
  corrected: boolean;
}

export interface AttendanceTodayDTO {
  record: AttendanceDTO | null;
  workDate: string;
  serverTime: string;
  onLeave: boolean;
  holiday: string | null;
}

// ---------------------------------------------------------------- dashboard, reports, AI

export interface DeadlineDTO {
  kind: 'project' | 'task';
  id: string;
  projectId: string;
  title: string;
  projectName: string;
  date: string;
  overdue: boolean;
}

export interface DashboardDTO {
  activeMembers: number;
  clientGuests: number;
  activeProjects: number;
  myOpenTasks: number;
  myOverdueTasks: number;
  todaySeconds: number;
  /** Null when the viewer cannot approve leave or timesheets. */
  pendingLeave: number | null;
  pendingTimesheets: number | null;
  pendingInvitations: number | null;
  upcomingDeadlines: DeadlineDTO[];
  recentUpdates: { id: string; projectId: string; projectName: string; author: string | null; body: string; createdAt: string; kind: FeedKind }[];
  notifications: NotificationDTO[];
  projects: { id: string; name: string; status: ProjectStatus; progress: number; estimatedHours: number | null; trackedHours: number | null; budget: number | null; currency: string; deadline: string | null }[];
  range: { from: string; to: string };
  rangeSeconds: number;
  /** The organisation's today (its timezone). */
  today: string;
  unreadNotifications: number;
  /** Null for clients, who have no HR or leave access. */
  upcomingHolidays: { date: string; name: string }[] | null;
  myLeave: { year: number; pending: number; balances: LeaveBalanceDTO[] } | null;
}

export type ReportKind = 'projects' | 'tasks' | 'time_by_project' | 'time_by_person' | 'billable' | 'budget' | 'timesheets' | 'attendance' | 'leave';

export interface ReportDTO {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  columns: { key: string; label: string; type: 'text' | 'number' | 'hours' | 'percent' | 'date' | 'money' }[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number> | null;
}

export interface AiAnswerDTO {
  id: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  sources: string[];
  createdAt: string;
}
