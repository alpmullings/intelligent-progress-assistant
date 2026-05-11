import { useCallback, useEffect, useMemo, useState } from 'react';
import './styles.css';
import type { AppState, ChatTurn, Goal, Plan, PlanStep, Settings } from './types';
import { loadState, resetState, saveState, uid } from './storage';
import { ChatIntake } from './components/ChatIntake';
import { PlanView } from './components/PlanView';
import { Dashboard } from './components/Dashboard';
import { CheckInScheduler } from './components/CheckInScheduler';

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  // Increments each time the scheduler fires; Dashboard listens and generates a coach turn.
  const [pendingProactiveAt, setPendingProactiveAt] = useState<number>(0);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const setChat = useCallback((chat: ChatTurn[]) => {
    setState(s => ({ ...s, chat }));
  }, []);

  const onGoalReady = useCallback((goal: Goal) => {
    setState(s => ({ ...s, goal, plan: undefined, phase: 'plan' }));
  }, []);

  const onAcceptPlan = useCallback((plan: Plan) => {
    setState(s => ({ ...s, plan, phase: 'dashboard' }));
  }, []);

  const onUpdatePlan = useCallback((plan: Plan) => {
    setState(s => ({ ...s, plan }));
  }, []);

  const onUpdateSettings = useCallback((settings: Settings) => {
    setState(s => ({ ...s, settings }));
  }, []);

  const setNextCheckInAt = useCallback((iso: string | undefined) => {
    setState(s => ({ ...s, nextCheckInAt: iso }));
  }, []);

  const onDraftPlanUpdate = useCallback((steps: PlanStep[]) => {
    setState(s => ({
      ...s,
      plan: {
        id: s.plan?.id ?? uid('plan_'),
        goalId: s.goal!.id,
        steps,
      },
    }));
  }, []);

  const fireProactiveCheckIn = useCallback(() => {
    setPendingProactiveAt(Date.now());
  }, []);

  const reset = useCallback(() => {
    if (!confirm('Reset everything — goal, plan, chat, settings?')) return;
    if (state.goal?.intakeDocId) {
      void import('./llm').then(({ deleteIntakeDoc }) => deleteIntakeDoc(state.goal!.intakeDocId!));
    }
    setState(resetState());
  }, []);

  const phaseTabs = useMemo(
    () => [
      { key: 'intake', label: 'Goal' },
      { key: 'plan', label: 'Plan' },
      { key: 'dashboard', label: 'Track' },
    ] as const,
    [],
  );

  const canVisit = (k: typeof phaseTabs[number]['key']) => {
    if (k === 'intake') return true;
    if (k === 'plan') return Boolean(state.goal);
    return Boolean(state.goal && state.plan?.acceptedAt);
  };

  return (
    <div className="app">
      <header className="brand">
        <div className="logo">IPA</div>
        <div>
          <h1>Intelligent Progress Assistant</h1>
          <small>Set SMART goals · plan · check in · stay on track.</small>
        </div>
      </header>

      <nav className="tabs">
        {phaseTabs.map(t => (
          <button
            key={t.key}
            className={state.phase === t.key ? 'active' : ''}
            disabled={!canVisit(t.key)}
            onClick={() => setState(s => ({ ...s, phase: t.key }))}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {state.phase === 'intake' && (
        <ChatIntake chat={state.chat} setChat={setChat} onGoalReady={onGoalReady} />
      )}

      {state.phase === 'plan' && state.goal && (
        <PlanView
          goal={state.goal}
          initialPlan={state.plan}
          onAccept={onAcceptPlan}
          onBack={() => setState(s => ({ ...s, phase: 'intake' }))}
          onDraftUpdate={onDraftPlanUpdate}
        />
      )}

      {state.phase === 'dashboard' && state.goal && state.plan && (
        <Dashboard
          goal={state.goal}
          plan={state.plan}
          chat={state.chat}
          settings={state.settings}
          pendingProactiveAt={pendingProactiveAt}
          onAppendChat={setChat}
          onUpdatePlan={onUpdatePlan}
          onUpdateSettings={onUpdateSettings}
          onReset={reset}
        />
      )}

      <CheckInScheduler
        enabled={state.phase === 'dashboard'}
        ratePerHour={state.settings.checkInRatePerHour}
        nextAt={state.nextCheckInAt}
        setNextAt={setNextCheckInAt}
        onFire={fireProactiveCheckIn}
      />

      <footer className="muted" style={{ textAlign: 'center', marginTop: 24, fontSize: 12 }}>
        MIT licensed · Local-only PWA · LLM via viarag.ai
      </footer>
    </div>
  );
}
