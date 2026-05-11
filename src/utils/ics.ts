import type { Plan, PlanStep, Goal } from '../types';

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function toIcsDate(yyyyMmDd: string): string {
  // All-day events use VALUE=DATE with YYYYMMDD.
  return yyyyMmDd.replace(/-/g, '');
}

function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function dtstamp(): string {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function eventBlock(uid: string, step: PlanStep, goalTitle: string): string {
  const dt = toIcsDate(step.targetDate);
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@intelligent-progress-assistant`,
    `DTSTAMP:${dtstamp()}`,
    `DTSTART;VALUE=DATE:${dt}`,
    `SUMMARY:${escapeIcs(step.title)}`,
    `DESCRIPTION:${escapeIcs(`${step.description}\n\nGoal: ${goalTitle}`)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT9H',
    'END:VALARM',
    'END:VEVENT',
  ].join('\r\n');
}

export function planToIcs(plan: Plan, goal: Goal): string {
  const events = plan.steps.map(s => eventBlock(s.id, s, goal.smartStatement));
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IntelligentProgressAssistant//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

export function downloadIcs(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
