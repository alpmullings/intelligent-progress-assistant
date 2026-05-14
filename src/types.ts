export type SmartFields = {
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  timeBound: string;
};

export type Goal = {
  id: string;
  rawWish: string;
  smart: SmartFields;
  smartStatement: string;
  createdAt: string;
  intakeDocId?: string;
};

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'overdue';

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  targetDate: string;
  status: StepStatus;
};

export type Plan = {
  id: string;
  goalId: string;
  steps: PlanStep[];
  acceptedAt?: string;
};

export type CheckInLog = {
  id: string;
  ts: string;
  stepId?: string;
  status: 'progress' | 'blocked' | 'skipped';
  note: string;
};

export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type AppPhase = 'intake' | 'plan' | 'dashboard';

export type Settings = {
  /** Mean check-ins per hour (Poisson rate). 1.0 means ~one every hour on average. */
  checkInRatePerHour: number;
  notificationsRequested: boolean;
};

export type AppState = {
  phase: AppPhase;
  goal?: Goal;
  plan?: Plan;
  checkIns: CheckInLog[];
  chat: ChatTurn[];
  nextCheckInAt?: string;
  settings: Settings;
};

export const DEFAULT_SETTINGS: Settings = {
  checkInRatePerHour: 1.0,
  notificationsRequested: false,
};
