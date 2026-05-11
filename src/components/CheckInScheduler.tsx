import { useEffect, useRef } from 'react';

type Props = {
  enabled: boolean;
  /** Mean check-ins per hour (Poisson rate λ). Sampled inter-arrival = -ln(U)/λ. */
  ratePerHour: number;
  /** ISO timestamp of next scheduled check-in (persisted in app state). */
  nextAt?: string;
  setNextAt: (iso: string | undefined) => void;
  onFire: () => void;
};

const MIN_DELAY_SEC = 30;
const MAX_DELAY_SEC = 6 * 3600;

function sampleDelaySeconds(ratePerHour: number): number {
  const λ = Math.max(0.001, ratePerHour) / 3600; // per second
  const u = Math.max(1e-9, Math.random());
  const raw = -Math.log(u) / λ;
  return Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, raw));
}

/**
 * Poisson check-in scheduler. While `enabled`, fires `onFire` at exponentially
 * distributed inter-arrival times with mean 1/ratePerHour. The next-fire time
 * is persisted so the schedule survives reloads.
 */
export function CheckInScheduler({ enabled, ratePerHour, nextAt, setNextAt, onFire }: Props) {
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!enabled) return;

    function armNew() {
      const delayMs = sampleDelaySeconds(ratePerHour) * 1000;
      const target = new Date(Date.now() + delayMs);
      setNextAt(target.toISOString());
      timeoutRef.current = window.setTimeout(fire, delayMs);
    }

    function armExisting(targetMs: number) {
      const delayMs = Math.max(0, targetMs - Date.now());
      timeoutRef.current = window.setTimeout(fire, delayMs);
    }

    function fire() {
      onFire();
      armNew();
    }

    if (nextAt) {
      const t = Date.parse(nextAt);
      if (Number.isFinite(t)) armExisting(t);
      else armNew();
    } else {
      armNew();
    }

    return () => {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // We deliberately re-arm whenever the rate changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ratePerHour]);

  return null;
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function fireChatNotification(body: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const n = new Notification('Coach', {
      body: body.slice(0, 140),
      icon: '/favicon.svg',
      tag: 'ipa-chat',
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* ignore */
  }
}
