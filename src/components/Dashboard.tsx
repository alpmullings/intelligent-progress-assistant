import { useEffect, useRef, useState } from 'react';
import type { ChatTurn, Goal, Plan, PlanStep, Settings, StepStatus } from '../types';
import { downloadIcs, planToIcs } from '../utils/ics';
import { coachReplyOnTrack, suggestRevision } from '../llm';
import { ensureNotificationPermission, fireChatNotification } from './CheckInScheduler';

type Props = {
  goal: Goal;
  plan: Plan;
  chat: ChatTurn[];
  settings: Settings;
  pendingProactiveAt: number; // increments to trigger a proactive coach turn
  onAppendChat: (turns: ChatTurn[]) => void;
  onUpdatePlan: (plan: Plan) => void;
  onUpdateSettings: (s: Settings) => void;
  onReset: () => void;
};

function statusLabel(s: StepStatus): string {
  return s === 'in_progress' ? 'In progress' : s === 'blocked' ? 'Blocked' : s === 'done' ? 'Done' : 'Pending';
}

function fmt(date: string): string {
  if (date.length > 10) {
    const d = new Date(date);
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
  }
  const parts = date.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function avgMinutesText(ratePerHour: number): string {
  const minutes = 60 / Math.max(0.01, ratePerHour);
  if (minutes < 90) return `≈ every ${Math.round(minutes)} min on average`;
  const hours = minutes / 60;
  return `≈ every ${hours.toFixed(1)} hr on average`;
}

export function Dashboard({
  goal,
  plan,
  chat,
  settings,
  pendingProactiveAt,
  onAppendChat,
  onUpdatePlan,
  onUpdateSettings,
  onReset,
}: Props) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRevise, setShowRevise] = useState(false);
  const [revising, setRevising] = useState(false);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastProactiveRef = useRef<number>(0);

  function setStatus(stepId: string, status: StepStatus) {
    onUpdatePlan({
      ...plan,
      steps: plan.steps.map(s => (s.id === stepId ? { ...s, status } : s)),
    });
  }

  function exportIcs() {
    const ics = planToIcs(plan, goal);
    downloadIcs(`progress-plan-${plan.id}.ics`, ics);
  }

  function mailto() {
    const lines = plan.steps.map(s => `• ${s.title} — due ${fmt(s.targetDate)}`).join('\n');
    const body = `Plan for: ${goal.smartStatement}\n\n${lines}`;
    const subject = `Progress plan: ${goal.smartStatement.slice(0, 60)}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function revisePlan() {
    setError(null);
    setRevising(true);
    try {
      const remaining = plan.steps.filter(s => s.status !== 'done');
      const lastUser = [...chat].reverse().find(t => t.role === 'user');
      const newSteps: PlanStep[] = await suggestRevision({
        smartStatement: goal.smartStatement,
        blocker: lastUser?.content,
        remainingSteps: remaining,
      });
      const done = plan.steps.filter(s => s.status === 'done');
      onUpdatePlan({ ...plan, steps: [...done, ...newSteps] });
      setShowRevise(false);
      onAppendChat([
        ...chat,
        { role: 'assistant', content: 'I revised the upcoming steps based on what you shared. Take a look at the timeline above and tweak anything that feels off.' },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan revision failed.');
    } finally {
      setRevising(false);
    }
  }

  async function generateCoachTurn(proactive: boolean, baseHistory: ChatTurn[]) {
    setError(null);
    setBusy(true);
    try {
      const { reply, suggestsRevision } = await coachReplyOnTrack({
        history: baseHistory,
        goal,
        plan,
        proactive,
      });
      const next: ChatTurn[] = [...baseHistory, { role: 'assistant', content: reply }];
      onAppendChat(next);
      if (suggestsRevision) setShowRevise(true);
      fireChatNotification(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coach call failed.');
    } finally {
      setBusy(false);
    }
  }

  // Fire proactive coach turn when the scheduler bumps pendingProactiveAt.
  useEffect(() => {
    if (pendingProactiveAt && pendingProactiveAt !== lastProactiveRef.current && !busy) {
      lastProactiveRef.current = pendingProactiveAt;
      void generateCoachTurn(true, chat);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProactiveAt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const next: ChatTurn[] = [...chat, { role: 'user', content: text }];
    onAppendChat(next);
    await generateCoachTurn(false, next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function checkInNow() {
    await generateCoachTurn(true, chat);
  }

  async function requestNotifs() {
    const p = await ensureNotificationPermission();
    setNotifPerm(p);
    onUpdateSettings({ ...settings, notificationsRequested: true });
  }

  const totals = plan.steps.reduce(
    (acc, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }),
    {} as Record<StepStatus, number>,
  );
  const total = plan.steps.length;
  const done = totals.done || 0;

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>Your timeline</strong>
          <span className="muted">Step 3 of 3</span>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <strong>{goal.smartStatement}</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            Progress: {done}/{total} done · {totals.blocked || 0} blocked · {totals.in_progress || 0} in progress
          </div>
        </div>

        <div className="toolbar">
          <button className="secondary" onClick={exportIcs}>Export to Outlook (.ics)</button>
          <button className="secondary" onClick={mailto}>Email plan</button>
          <button className="secondary" onClick={revisePlan} disabled={revising}>
            {revising ? 'Revising…' : 'Revise with AI'}
          </button>
          <button className="danger" onClick={onReset}>Reset</button>
        </div>

        {plan.steps.map((s, i) => (
          <div key={s.id} className={`step ${s.status}`}>
            <div className="marker">{i + 1}</div>
            <div>
              <h4>{s.title}</h4>
              <p>{s.description}</p>
              <div className="meta">
                <span>Due {fmt(s.targetDate)}</span>
                <span>· {statusLabel(s.status)}</span>
              </div>
            </div>
            <div className="actions">
              <select
                value={s.status}
                onChange={e => setStatus(s.id, e.target.value as StepStatus)}
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>Coach chat</strong>
          <button className="secondary" onClick={checkInNow} disabled={busy}>Check in now</button>
        </div>

        <div className="chat" ref={scrollRef}>
          {chat.length === 0 && (
            <div className="muted">No messages yet. Your coach will check in proactively, or tap "Check in now".</div>
          )}
          {chat.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              {t.content}
            </div>
          ))}
          {busy && <div className="bubble assistant thinking">Coach is typing…</div>}
        </div>

        {showRevise && (
          <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
            <span className="muted">Coach suggests revising the plan.</span>
            <div className="row">
              <button className="ghost" onClick={() => setShowRevise(false)}>Not now</button>
              <button className="primary" onClick={revisePlan} disabled={revising}>
                {revising ? 'Revising…' : 'Apply AI revision'}
              </button>
            </div>
          </div>
        )}

        <div className="composer">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Reply to your coach. Enter to send, Shift+Enter for newline."
            disabled={busy}
          />
          <button className="primary" onClick={send} disabled={busy || !input.trim()}>Send</button>
        </div>

        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <strong>Check-in settings</strong>
        <p className="muted" style={{ marginTop: 6 }}>
          Coach check-ins are sampled from a Poisson distribution with mean rate λ. Lower rate → fewer, more spaced check-ins.
        </p>
        <div className="row" style={{ marginTop: 8, gap: 12, alignItems: 'center' }}>
          <label htmlFor="rate" style={{ minWidth: 140 }}>Check-ins / hour: <strong>{settings.checkInRatePerHour.toFixed(2)}</strong></label>
          <input
            id="rate"
            type="range"
            min={0.05}
            max={6}
            step={0.05}
            value={settings.checkInRatePerHour}
            onChange={e =>
              onUpdateSettings({ ...settings, checkInRatePerHour: parseFloat(e.target.value) })
            }
            style={{ flex: 1 }}
          />
          <span className="muted">{avgMinutesText(settings.checkInRatePerHour)}</span>
        </div>
        {notifPerm !== 'granted' && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <span className="muted">
              {notifPerm === 'denied'
                ? 'Browser notifications are blocked. Enable them in site permissions if you want background nudges.'
                : 'Enable browser notifications so backgrounded check-ins surface like a messaging app.'}
            </span>
            <button className="secondary" onClick={requestNotifs} disabled={notifPerm === 'denied'}>
              Enable notifications
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
