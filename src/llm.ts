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

const COACH_SYSTEM = `You are a friendly SMART-goal coach. The user wants to set one goal.
Walk them through making it SMART (Specific, Measurable, Achievable, Relevant, Time-bound).
Ask ONE crisp question at a time. Keep replies under 60 words. Reference what they've
already said. When you have enough detail across all five SMART dimensions, end your
reply with the exact token <READY> on its own line.`;

export type CoachReply = { reply: string; ready: boolean };

export async function coachNextTurn(history: ChatTurn[]): Promise<CoachReply> {
  const transcript = history
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
};

export async function generatePlan(smartStatement: string): Promise<PlanStep[]> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a planning coach. Given this SMART goal, produce a concrete action plan.
Today is ${today}. The plan must have 4-8 steps, ordered, each with a target date relative to today.
Return ONLY a JSON array (no prose, no code fences) of objects with this shape:
[
  { "title": "short imperative", "description": "one-sentence what + why", "daysFromNow": 3 }
]
Rules:
- Steps must be specific actions the user can do (verbs first).
- daysFromNow must be a positive integer; the final step should be near the goal's deadline.
- Keep titles under 60 chars; descriptions under 180 chars.

SMART goal:
${smartStatement}`;
  const raw = await direct(prompt);
  const arr = extractJson<RawPlanStep[]>(raw);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Plan generation returned no steps');
  const now = Date.now();
  return arr.slice(0, 12).map((s, i) => ({
    id: uid('step_'),
    title: String(s.title || `Step ${i + 1}`).slice(0, 80),
    description: String(s.description || '').slice(0, 240),
    targetDate: new Date(now + Math.max(1, Math.round(s.daysFromNow || (i + 1) * 3)) * 86400000)
      .toISOString()
      .slice(0, 10),
    status: 'pending' as const,
  }));
}

export async function suggestRevision(args: {
  smartStatement: string;
  missedStep?: PlanStep;
  blocker?: string;
  remainingSteps: PlanStep[];
}): Promise<PlanStep[]> {
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
  const arr = extractJson<RawPlanStep[]>(raw);
  const now = Date.now();
  return arr.slice(0, 10).map((s, i) => ({
    id: uid('step_'),
    title: String(s.title || `Step ${i + 1}`).slice(0, 80),
    description: String(s.description || '').slice(0, 240),
    targetDate: new Date(now + Math.max(1, Math.round(s.daysFromNow || (i + 1) * 3)) * 86400000)
      .toISOString()
      .slice(0, 10),
    status: 'pending' as const,
  }));
}

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}

const TRACK_SYSTEM = `You are now in TRACKING mode — the user's SMART goal and plan are in place.
You are a warm, brief accountability partner over text chat. Keep replies under 80 words.
Be specific to their plan: reference step titles and due dates when relevant.
If the user clearly says they are blocked, stuck, behind, or wants to change scope/dates,
append the exact token <REVISE> on its own line at the end of your reply — the app uses
this to surface a "Revise plan with AI" button. Do NOT use <REVISE> for simple status updates.`;

function planSummary(plan: Plan): string {
  return plan.steps
    .map((s, i) => `${i + 1}. [${s.status}] ${s.title} (due ${s.targetDate}) — ${s.description}`)
    .join('\n');
}

function recentTranscript(history: ChatTurn[], maxTurns = 16): string {
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
}): Promise<TrackReply> {
  const today = new Date().toISOString().slice(0, 10);
  const directive = args.proactive
    ? `Write a friendly, *proactive* check-in (1-3 sentences). Ask about progress on the most relevant pending or in-progress step — not all of them. If a step is overdue, mention it gently.`
    : `Reply to the user's latest message. Acknowledge what they shared, then either (a) ask one useful follow-up, or (b) suggest a concrete micro-action they can do today.`;

  const prompt = `${TRACK_SYSTEM}

Today is ${today}.
Goal: ${args.goal.smartStatement}

Plan:
${planSummary(args.plan)}

Recent chat:
${recentTranscript(args.history)}

${directive}

Write the COACH's reply only (no role prefix).`;

  const raw = await direct(prompt);
  const suggestsRevision = /<REVISE>/.test(raw);
  const reply = raw.replace(/<REVISE>/g, '').trim();
  return { reply, suggestsRevision };
}
