import type { QuietHours } from '../autopilot/session';
import type { UserRole } from '../domain/enums';

// Notifications and remote approvals (ADR-038, docs/plans/notifications.md). Everything in this folder is IO-free:
// persistence, channels and the clock are ports supplied by the composition root.

export const NOTIFICATION_KINDS = [
  'approval.requested',
  'approval.resolved',
  'budget.warning',
  'budget.exhausted',
  'ci.failed',
  'run.finished',
  'run.failed',
  'autopilot.stopped',
  'room.mention',
  'channel.problem',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** External delivery channels. Web Push, e-mail and Discord follow in later stages (owner order: Telegram → Web Push → e-mail → Discord). */
export const CHANNEL_KINDS = ['telegram'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Preferences address the in-app centre and every external channel kind. */
export const PREFERENCE_CHANNELS = ['in_app', ...CHANNEL_KINDS] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

export const PREFERENCE_MODES = ['instant', 'digest', 'off'] as const;
export type PreferenceMode = (typeof PREFERENCE_MODES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * minimal (default): external messages never name projects or tasks, only a generic text and a link.
 * standard: sanitised project name and task title are included (opt-in per user).
 */
export const PREVIEW_LEVELS = ['minimal', 'standard'] as const;
export type PreviewLevel = (typeof PREVIEW_LEVELS)[number];

export const CHANNEL_STATUSES = ['pending', 'active', 'disabled', 'failed'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const DELIVERY_STATUSES = ['queued', 'held', 'batched', 'sent', 'failed', 'dead', 'suppressed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Whitelisted, sanitised parameters. Never secrets, code, paths, logs, model output or message bodies. */
export interface NotificationParams {
  projectName?: string;
  taskTitle?: string;
  action?: string;
  risk?: string;
  status?: string;
  percent?: number;
  scope?: string;
  classification?: string;
  reason?: string;
  by?: string;
  channelKind?: string;
}

/** Ids only. */
export interface NotificationRefs {
  approvalId?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  conversationId?: string;
  messageId?: string;
  channelId?: string;
}

export interface NotificationIntent {
  userId: string;
  kind: NotificationKind;
  severity: Severity;
  projectId: string | null;
  params: NotificationParams;
  refs: NotificationRefs;
  sourceEventId: string | null;
  /** Unique per user: re-routing the same event never creates a second notification. */
  dedupeKey: string;
  /** Similar notifications within the coalescing window are folded into one entry and one external message. */
  groupKey: string | null;
  actionable: boolean;
  /** Only for security kills of an autopilot session. */
  breakThroughQuietHours: boolean;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  projectId: string | null;
  kind: NotificationKind;
  severity: Severity;
  params: NotificationParams;
  refs: NotificationRefs;
  sourceEventId: string | null;
  dedupeKey: string;
  groupKey: string | null;
  /** Number of coalesced occurrences represented by this entry. */
  count: number;
  /** Set on entries folded into an earlier one; hidden from the list. */
  coalescedInto: string | null;
  actionable: boolean;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
  resolvedAt: Date | null;
}

export type NewNotification = NotificationIntent & { readAt?: Date | null };

export interface NotificationSettings {
  userId: string;
  timeZone: string;
  quietHours: QuietHours | null;
  previewLevel: PreviewLevel;
  /** Approvals from outside the app (Telegram, confirm page). Off until the user enables it (owner decision). */
  remoteApprovals: boolean;
  updatedAt: Date | null;
}

export function defaultNotificationSettings(userId: string): NotificationSettings {
  return { userId, timeZone: 'UTC', quietHours: null, previewLevel: 'minimal', remoteApprovals: false, updatedAt: null };
}

export interface PreferenceOverride {
  kind: NotificationKind;
  channel: PreferenceChannel;
  mode: PreferenceMode;
}

export interface ProjectMute {
  projectId: string;
  until: Date | null;
}

export interface ChannelRecord {
  id: string;
  userId: string;
  kind: ChannelKind;
  label: string;
  status: ChannelStatus;
  /** Opaque to core: encrypted by the composition root (ADR-009). */
  targetEncrypted: string;
  /** Keyed hash of the platform identity (e.g. the Telegram user id), unique per kind. */
  targetFingerprint: string;
  createdAt: Date;
  verifiedAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

export type NewChannel = Pick<ChannelRecord, 'userId' | 'kind' | 'label' | 'status' | 'targetEncrypted' | 'targetFingerprint'>;
export type ChannelPatch = Partial<Pick<ChannelRecord, 'label' | 'status' | 'targetEncrypted' | 'verifiedAt' | 'lastSuccessAt' | 'consecutiveFailures' | 'disabledReason'>>;

export interface DeliveryRecord {
  id: string;
  notificationId: string;
  channelId: string;
  userId: string;
  status: DeliveryStatus;
  notBefore: Date;
  attempts: number;
  providerRef: string | null;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewDelivery = Pick<DeliveryRecord, 'notificationId' | 'channelId' | 'userId' | 'status' | 'notBefore'>;
export type DeliveryPatch = Partial<Pick<DeliveryRecord, 'status' | 'notBefore' | 'attempts' | 'providerRef' | 'lastError' | 'sentAt'>>;

export const ACTION_TOKEN_DECISIONS = ['approve', 'reject', 'review'] as const;
/** approve/reject: one-tap platform buttons; review: the confirm page in the logged-in app, where the user chooses. */
export type ActionTokenDecision = (typeof ACTION_TOKEN_DECISIONS)[number];

export interface ActionTokenRecord {
  id: string;
  tokenHash: string;
  approvalId: string;
  userId: string;
  decision: ActionTokenDecision;
  approvalDigest: string;
  channelKind: ChannelKind | 'in_app';
  deliveryId: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedVia: string | null;
}

export type NewActionToken = Pick<ActionTokenRecord, 'tokenHash' | 'approvalId' | 'userId' | 'decision' | 'approvalDigest' | 'channelKind' | 'deliveryId' | 'expiresAt'>;

export interface DirectoryUser {
  id: string;
  login: string;
  role: UserRole;
}
