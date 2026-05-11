import { useEffect, useRef, useState } from 'react';
import type { ChatTurn, Goal, Plan, PlanStep } from '../types';
import { generatePlan } from '../llm';
import { uid } from '../storage';

type Props = {
  goal: Goal;
  chat: ChatTurn[];
  initialPlan?: Plan;
  onAccept: (plan: Plan) => void;
  onBack: () => void;
  onDraftUpdate?: (steps: PlanStep[]) => void;
};

export function PlanView({ goal, chat, initialPlan, onAccept, onBack, onDraftUpdate }: Props) {
  const [steps, setSteps] = useState<PlanStep[]>(initialPlan?.steps ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);

  useEffect(() => {
    if (steps.length === 0) {
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (steps.length > 0 && onDraftUpdate) {
      onDraftUpdate(steps);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await generatePlan(goal, chat);
      setSteps(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan generation failed.');
    } finally {
      setBusy(false);
    }
  }

  function moveStep(from: number, to: number) {
    if (from === to) return;
    setSteps(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function onDragStart(i: number) {
    dragIndex.current = i;
  }

  function onDragEnter(i: number) {
    dragOverIndex.current = i;
  }

  function onDragEnd() {
    if (dragIndex.current !== null && dragOverIndex.current !== null) {
      moveStep(dragIndex.current, dragOverIndex.current);
    }
    dragIndex.current = null;
    dragOverIndex.current = null;
  }

  function updateStep(id: string, patch: Partial<PlanStep>) {
    setSteps(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeStep(id: string) {
    setSteps(prev => prev.filter(s => s.id !== id));
  }

  function addStep() {
    const last = steps[steps.length - 1]?.targetDate;
    const base = last ? new Date(last) : new Date();
    const next = new Date(base.getTime() + 7 * 86400000);
    const nextStr = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}T09:00`;
    setSteps(prev => [
      ...prev,
      {
        id: uid('step_'),
        title: 'New step',
        description: '',
        targetDate: nextStr,
        status: 'pending',
      },
    ]);
  }

  function accept() {
    const plan: Plan = {
      id: initialPlan?.id ?? uid('plan_'),
      goalId: goal.id,
      steps: [...steps].sort((a, b) => a.targetDate.localeCompare(b.targetDate)),
      acceptedAt: new Date().toISOString(),
    };
    onAccept(plan);
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Review your plan</strong>
        <span className="muted">Step 2 of 3</span>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <strong>SMART goal</strong>
        <p style={{ margin: '8px 0 12px' }}>{goal.smartStatement}</p>
        <dl className="smart-grid">
          <dt>Specific</dt><dd>{goal.smart.specific}</dd>
          <dt>Measurable</dt><dd>{goal.smart.measurable}</dd>
          <dt>Achievable</dt><dd>{goal.smart.achievable}</dd>
          <dt>Relevant</dt><dd>{goal.smart.relevant}</dd>
          <dt>Time-bound</dt><dd>{goal.smart.timeBound}</dd>
        </dl>
      </div>

      <div className="toolbar">
        <button className="secondary" onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Regenerate plan'}
        </button>
        <button className="secondary" onClick={addStep}>+ Add step</button>
        <span className="muted">Edit anything inline.</span>
      </div>

      {error && <div className="error">{error}</div>}

      {steps.map((s, i) => (
        <div
          key={s.id}
          className={`step ${s.status}`}
          draggable
          onDragStart={() => onDragStart(i)}
          onDragEnter={() => onDragEnter(i)}
          onDragEnd={onDragEnd}
          onDragOver={e => e.preventDefault()}
          style={{ cursor: 'grab' }}
        >
          <div className="marker">{i + 1}</div>
          <div>
            <input
              value={s.title}
              onChange={e => updateStep(s.id, { title: e.target.value })}
              style={{
                background: 'transparent', border: 0, color: 'inherit',
                font: 'inherit', fontWeight: 700, width: '100%',
              }}
            />
            <textarea
              value={s.description}
              onChange={e => updateStep(s.id, { description: e.target.value })}
              rows={2}
              style={{
                background: 'transparent', border: 0, color: 'var(--muted)',
                font: 'inherit', width: '100%', resize: 'vertical', padding: 0, marginTop: 4,
              }}
            />
            <div className="meta">
              <label>Due:&nbsp;
                <input
                  type="datetime-local"
                  value={s.targetDate.length === 10 ? s.targetDate + 'T09:00' : s.targetDate}
                  onChange={e => updateStep(s.id, { targetDate: e.target.value })}
                />
              </label>
            </div>
          </div>
          <div className="actions">
            <span title="Drag to reorder" style={{ cursor: 'grab', color: 'var(--muted)', fontSize: 18, padding: '0 4px', userSelect: 'none' }}>⠿</span>
            <button className="danger" onClick={() => removeStep(s.id)}>Remove</button>
          </div>
        </div>
      ))}

      <div className="row end" style={{ marginTop: 12 }}>
        <button className="ghost" onClick={onBack}>← Back to chat</button>
        <button className="primary" onClick={accept} disabled={steps.length === 0 || busy}>
          Accept plan
        </button>
      </div>
    </div>
  );
}
