import { useEffect, useRef, useState } from 'react';
import type { ChatTurn, Goal, SmartFields } from '../types';
import { coachNextTurn, embedIntakeChat, extractSmart, hasApiKey } from '../llm';
import { uid } from '../storage';

const OPENER = "Hi! I'm here to help you turn a goal into a SMART plan. In one or two sentences, what's the goal you want to make progress on?";

type Props = {
  chat: ChatTurn[];
  setChat: (turns: ChatTurn[]) => void;
  onGoalReady: (goal: Goal) => void;
};

export function ChatIntake({ chat, setChat, onGoalReady }: Props) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chat.length === 0) {
      setChat([{ role: 'assistant', content: OPENER }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setInput('');
    const next: ChatTurn[] = [...chat, { role: 'user', content: text }];
    setChat(next);
    setBusy(true);
    try {
      const { reply, ready: isReady } = await coachNextTurn(next);
      const updated: ChatTurn[] = [...next, { role: 'assistant', content: reply }];
      setChat(updated);
      setReady(isReady);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coach call failed.');
      setChat(next);
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    setError(null);
    setBusy(true);
    try {
      const { smart, smartStatement } = await extractSmart(chat);
      const rawWish = chat.find(t => t.role === 'user')?.content ?? '';
      const goalId = uid('goal_');
      let intakeDocId: string | undefined;
      try {
        intakeDocId = await embedIntakeChat(chat, goalId);
      } catch {
        // non-fatal — plan generation falls back to direct query
      }
      const goal: Goal = {
        id: goalId,
        rawWish,
        smart: smart as SmartFields,
        smartStatement,
        createdAt: new Date().toISOString(),
        intakeDocId,
      };
      onGoalReady(goal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not extract SMART goal. Add a bit more detail and try again.');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Set your SMART goal</strong>
        <span className="muted">Step 1 of 3</span>
      </div>

      {!hasApiKey() && (
        <div className="error">
          Missing <code>VITE_VIARAG_API_KEY</code>. Add it to <code>.env.local</code> and restart{' '}
          <code>npm run dev</code>.
        </div>
      )}

      <div className="chat" ref={scrollRef}>
        {chat.map((t, i) => (
          <div key={i} className={`bubble ${t.role}`}>
            {t.content}
          </div>
        ))}
        {busy && <div className="bubble assistant thinking">Coach is thinking…</div>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your reply. Enter to send, Shift+Enter for a new line."
          disabled={busy}
        />
        <button className="primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <span className="muted">
          {ready
            ? "Coach says we're ready — finalize when you are."
            : 'Keep chatting until your goal feels SMART (or finalize anytime).'}
        </span>
        <button className="primary" disabled={busy || chat.length < 3} onClick={finalize}>
          Finalize SMART goal
        </button>
      </div>
    </div>
  );
}
