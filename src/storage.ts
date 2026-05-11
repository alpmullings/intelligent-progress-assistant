import { DEFAULT_SETTINGS, type AppState } from './types';

const KEY = 'ipa.state.v1';

const empty = (): AppState => ({
  phase: 'intake',
  checkIns: [],
  chat: [],
  settings: { ...DEFAULT_SETTINGS },
});

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...empty(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch {
    return empty();
  }
}

export function saveState(state: AppState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetState(): AppState {
  const fresh = empty();
  saveState(fresh);
  return fresh;
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
