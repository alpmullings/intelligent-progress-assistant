import { ViaRAGClient } from 'viarag';
import type { ChatTurn, Goal, Plan, PlanStep, SmartFields } from './types';
import { uid } from './storage';

const apiKey = import.meta.env.VITE_VIARAG_API_KEY as string | undefined;

let _client: ViaRAGClient | null = null;
function client(): ViaRAGClient {
  if (!_client) {
    if (!apiKey) throw new Error('VITE_VIARAG_API_KEY is not set. Add it to .env.local and restart `npm run dev`.');
    _client = new ViaRAGClient({ apiKey });
  }
  return _client;
}

function unwrap(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    for (const k of ['response', 'text', 'output', 'content', 'message', 'answer', 'result']) {
      const v = r[k];
      if (typeof v === 'string' && v.length) return v;
    }
    if (Array.isArray(r.choices) && r.choices.length) {
      const c = r.choices[0] as Record<string, unknown>;
      if (c.message && typeof (c.message as { content?: unknown }).content === 'string') {
        return (c.message as { content: string }).content;
      }
      if (typeof c.text === 'string') return c.text;
    }
  }
  return JSON.stringify(resp);
}

async function direct(prompt: string): Promise<string> {
  const c = client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (c.directQuery as any)(prompt);
  return unwrap(res).trim();
}

function extractJson<T>(raw: string): T {
  // Strip code fences if present.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  // Find the first balanced JSON object or array.
  const objStart = body.indexOf('{');
  const arrStart = body.indexOf('[');
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start < 0) throw new Error('No JSON found in model output');
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (end <= start) throw new Error('Malformed JSON in model output');
  return JSON.parse(body.slice(start, end + 1)) as T;
}

function localDatetimeFromDays(daysFromNow: number, timeOfDay?: string): string {
  const now = new Date();
  const d = new Date(now.getTime() + Math.max(1, Math.round(daysFromNow)) * 86400000);
  const t = timeOfDay && /^\d{2}:\d{2}$/.test(timeOfDay)
    ? timeOfDay
    : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${t}`;
}

// Finds and parses the outermost JSON array from raw LLM output, tolerating surrounding prose.
function extractJsonArray<T>(raw: string): T[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  if (start < 0) throw new Error('No JSON array found in model output');
  let depth = 0;
  let end = -1;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '[') depth++;
    else if (body[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('Malformed JSON array in model output');
  return JSON.parse(body.slice(start, end + 1)) as T[];
}

const COACH_SYSTEM = `You are a friendly SMART-goal coach. Walk the user through making their goal Specific, Measurable, Achievable, Relevant, and Time-bound.
Ask ONE crisp question at a time. Keep replies under 60 words. Reference what they've already said.
Once all five SMART dimensions are clear, end your reply with <READY> on its own line.`;

export type CoachReply = { reply: string; ready: boolean };

export async function coachNextTurn(history: ChatTurn[]): Promise<CoachReply> {
  // Cap at last 12 turns — intake rarely exceeds this before <READY>.
  const transcript = history
    .slice(-12)
    .map(t => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`)
    .join('\n');
  const prompt = `${COACH_SYSTEM}\n\nConversation so far:\n${transcript}\n\nWrite the COACH's next reply only (no role prefix).`;
  const raw = await direct(prompt);
  const ready = /<READY>/.test(raw);
  const reply = raw.replace(/<READY>/g, '').trim();
  return { reply, ready };
}

export async function extractSmart(history: ChatTurn[]): Promise<{ smart: SmartFields; smartStatement: string }> {
  const transcript = history
    .map(t => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`)
    .join('\n');
  const prompt = `Read this goal-setting conversation and extract the user's SMART goal.
Return ONLY a JSON object with this exact shape (no prose, no code fences):
{
  "specific": "...",
  "measurable": "...",
  "achievable": "...",
  "relevant": "...",
  "timeBound": "...",
  "smartStatement": "A single 1-2 sentence SMART goal statement in the user's voice."
}

Conversation:
${transcript}`;
  const raw = await direct(prompt);
  const parsed = extractJson<SmartFields & { smartStatement: string }>(raw);
  const { smartStatement, ...smart } = parsed;
  return { smart, smartStatement };
}

export type RawPlanStep = {
  title: string;
  description: string;
  daysFromNow: number;
  timeOfDay?: string; // HH:MM derived from conversation context, e.g. "09:00"
};

export async function embedIntakeChat(history: ChatTurn[], goalId: string): Promise<string> {
  const c = client();
  const transcript = history
    .map(t => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`)
    .join('\n');
  const result = await c.embed(transcript, {
    metadata: { goalId, type: 'intake-chat' },
    chunking: { chunkSize: 500, chunkOverlap: 50 },
  });
  return (result as unknown as { doc_id: string }).doc_id;
}

export async function deleteIntakeDoc(docId: string): Promise<void> {
  try {
    await client().delete(docId);
  } catch {
    // best-effort cleanup
  }
}

export async function generatePlan(goal: Goal, history: ChatTurn[]): Promise<PlanStep[]> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const transcript = history
    .map(t => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`)
    .join('\n');

  const prompt = `You are a planning coach. Given this SMART goal, produce a concrete action plan.
Today is ${today}. Output 4-8 ordered steps as a JSON array only (no prose, no code fences):
[ { "title": "<imperative, ≤60 chars>", "description": "<what + why, ≤180 chars>", "daysFromNow": 3, "timeOfDay": "09:00" } ]
Rules:
- daysFromNow: positive integer. Final step near the goal deadline.
- timeOfDay: 24h HH:MM. Derive from conversation ("morning"→09:00, "end of day"→17:00, "evening"→19:00). Default 09:00 for actions, 17:00 for deadlines.
- Honour EVERY quantity, schedule, and target the user stated — do not round or re-derive.
- Use all SMART dimensions; verbs first in titles.

SMART goal: ${goal.smartStatement}
S: ${goal.smart.specific}
M: ${goal.smart.measurable}
A: ${goal.smart.achievable}
R: ${goal.smart.relevant}
T: ${goal.smart.timeBound}

Intake conversation:
${transcript}`;

  const raw = await direct(prompt);
  const arr = extractJsonArray<RawPlanStep>(raw);
  if (arr.length === 0) throw new Error('Plan generation returned no steps');
  return arr.slice(0, 12).map((s, i) => ({
    id: uid('step_'),
    title: String(s.title || `Step ${i + 1}`).slice(0, 80),
    description: String(s.description || '').slice(0, 240),
    targetDate: localDatetimeFromDays(s.daysFromNow || (i + 1) * 3, s.timeOfDay),
    status: 'pending' as const,
  }));
}

export async function suggestRevision(args: {
  smartStatement: string;
  missedStep?: PlanStep;
  blocker?: string;
  remainingSteps: PlanStep[];
}): Promise<PlanStep[]> {
  type RawReviseStep = { title: string; description: string; daysFromNow: number };
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are revising a plan because of a blocker or missed step.
Today is ${today}.
Original SMART goal: ${args.smartStatement}
${args.missedStep ? `Step that was missed/blocked: "${args.missedStep.title}" (was due ${args.missedStep.targetDate}).` : ''}
${args.blocker ? `Blocker note from user: "${args.blocker}"` : ''}
Remaining planned steps (you can reorder/edit/drop these):
${args.remainingSteps.map((s, i) => `${i + 1}. ${s.title} (due ${s.targetDate}) — ${s.description}`).join('\n')}

Return ONLY a JSON array (no prose, no code fences) of the REVISED upcoming steps with this shape:
[ { "title": "...", "description": "...", "daysFromNow": 2 } ]
Rules:
- 3-7 steps. Adjust scope or dates to make the plan realistic again.
- daysFromNow is relative to today.`;
  const raw = await direct(prompt);
  const arr = extractJsonArray<RawReviseStep>(raw);
  return arr.slice(0, 10).map((s, i) => ({
    id: uid('step_'),
    title: String(s.title || `Step ${i + 1}`).slice(0, 80),
    description: String(s.description || '').slice(0, 240),
    targetDate: localDatetimeFromDays(s.daysFromNow || (i + 1) * 3),
    status: 'pending' as const,
  }));
}

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}

const TRACK_SYSTEM = `TRACKING MODE. You are a warm, brief accountability partner. Keep replies under 80 words.
Reference step titles and due dates when relevant. You are time-aware: a progress context line
shows % time elapsed vs % steps done — if time elapsed significantly exceeds steps done, say so.
Steps marked [overdue] must be acknowledged; use <REVISE> for overdue items.
Append <REVISE> on its own line only when the user is blocked, stuck, behind, or wants to change scope/dates.
Never use <REVISE> for simple status updates.`;

function planSummary(plan: Plan): string {
  // Omit descriptions — title + status + date is sufficient for coaching context.
  return plan.steps
    .map((s, i) => `${i + 1}. [${s.status}] ${s.title} (due ${s.targetDate})`)
    .join('\n');
}

function timeContext(plan: Plan): string {
  const now = new Date();
  const start = plan.acceptedAt ? new Date(plan.acceptedAt) : now;
  const deadlines = plan.steps.map(s => new Date(s.targetDate).getTime()).filter(t => !isNaN(t));
  const lastDeadline = deadlines.length ? Math.max(...deadlines) : now.getTime();
  const totalMs = lastDeadline - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();
  const elapsedPct = totalMs > 0 ? Math.min(100, Math.round((elapsedMs / totalMs) * 100)) : 0;
  const done = plan.steps.filter(s => s.status === 'done').length;
  const donePct = plan.steps.length > 0 ? Math.round((done / plan.steps.length) * 100) : 0;
  const overdue = plan.steps.filter(s => s.status === 'overdue');
  let ctx = `Progress context: ${elapsedPct}% of plan time elapsed, ${donePct}% of steps done (${done}/${plan.steps.length}).`;
  if (overdue.length > 0) {
    ctx += ` OVERDUE (${overdue.length}): ${overdue.map(s => s.title).join('; ')}.`;
  }
  return ctx;
}

function recentTranscript(history: ChatTurn[], maxTurns = 8): string {
  return history
    .slice(-maxTurns)
    .map(t => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`)
    .join('\n');
}

export type TrackReply = { reply: string; suggestsRevision: boolean };

/**
 * Generates a coach turn while the plan is active. Used for two cases:
 *  - Proactive check-in (no user message yet) — pass `proactive: true`.
 *  - User-initiated chat — pass `proactive: false`; the user's latest turn must already be in history.
 */
export async function coachReplyOnTrack(args: {
  history: ChatTurn[];
  goal: Goal;
  plan: Plan;
  proactive: boolean;
  imminentStepTitle?: string;
}): Promise<TrackReply> {
  const today = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const directive = args.imminentStepTitle
    ? `DEADLINE ALERT: "${args.imminentStepTitle}" is due in approximately 5 minutes. Ask directly if the user is about to complete it right now, or if the plan needs revision. Append <REVISE> if they won't finish in time.`
    : args.proactive
      ? `Write a friendly, *proactive* check-in (1-3 sentences). Reference the progress context above. Ask about the most relevant pending or in-progress step. If time elapsed significantly exceeds steps done, mention the gap. If any steps are overdue, call them out and use <REVISE>.`
      : `Reply to the user's latest message. Acknowledge what they shared, then either (a) ask one useful follow-up, or (b) suggest a concrete micro-action they can do today.`;

  // Proactive check-ins only need recent context; user-initiated replies need more history
  // so the coach doesn't repeat questions or miss a blocker mentioned a few turns back.
  const transcriptTurns = args.proactive ? 8 : 16;

  const prompt = `${TRACK_SYSTEM}

Today is ${today}, current time is ${nowTime}.
Goal: ${args.goal.smartStatement}
${timeContext(args.plan)}

Plan:
${planSummary(args.plan)}

Recent chat:
${recentTranscript(args.history, transcriptTurns)}

${directive}

Write the COACH's reply only (no role prefix).`;

  const raw = await direct(prompt);
  const suggestsRevision = /<REVISE>/.test(raw);
  const reply = raw.replace(/<REVISE>/g, '').trim();
  return { reply, suggestsRevision };
}
