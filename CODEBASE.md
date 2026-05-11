# Intelligent Progress Assistant — Codebase Reference

## What It Is

A single-user **Progressive Web App** (PWA) that guides a user through:
1. Setting a SMART goal via conversational AI
2. Generating and editing a step-by-step action plan
3. Tracking progress with proactive AI coach check-ins

All data is **local-only** (localStorage). LLM calls go to **viarag.ai** via the `viarag` npm SDK. MIT licensed.

**Deployment:** Netlify via manual browser deploy (build output: `dist/`). No `netlify.toml` — static SPA, no server-side routing needed.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite 5 + `@vitejs/plugin-react` |
| PWA | `vite-plugin-pwa` (Workbox, auto-update, standalone) |
| LLM | `viarag` npm SDK — `ViaRAGClient.directQuery()` for all generation; `embedIntakeChat()` stores intake transcript (reserved for future RAG use) |
| Storage | `localStorage` key `ipa.state.v1` |
| Styling | Single CSS file, dark theme, no component library |
| Calendar | `.ics` file generation + `mailto:` link |

**Dev server:** `npm run dev` → `localhost:5173`  
**Env var required:** `VITE_VIARAG_API_KEY` in `.env.local`

---

## App State & Data Model (`src/types.ts`)

```
AppState
├── phase: 'intake' | 'plan' | 'dashboard'
├── goal?: Goal
│   ├── id, rawWish, createdAt
│   ├── smart: { specific, measurable, achievable, relevant, timeBound }
│   ├── smartStatement: string          ← single LLM-composed goal sentence
│   └── intakeDocId?: string            ← viarag doc_id of embedded intake transcript (optional)
├── plan?: Plan
│   ├── id, goalId, acceptedAt?         ← acceptedAt only set after user clicks "Accept plan"
│   └── steps: PlanStep[]
│       └── { id, title, description, targetDate (YYYY-MM-DDTHH:MM), status }
│           status: 'pending' | 'in_progress' | 'done' | 'blocked'
├── checkIns: CheckInLog[]              ← currently unused by UI (reserved)
├── chat: ChatTurn[]                    ← shared across all phases
├── nextCheckInAt?: string              ← ISO timestamp, persisted for reload survival
└── settings: Settings
    ├── checkInRatePerHour: number      ← default 1.0 (Poisson λ)
    └── notificationsRequested: boolean
```

**Important:** `targetDate` is stored as `YYYY-MM-DDTHH:MM` (datetime-local format), not date-only. Legacy `YYYY-MM-DD` values are handled gracefully. `plan.acceptedAt` is the gate for the Dashboard tab — a draft plan (no `acceptedAt`) does not unlock it.

State is saved to localStorage on every change (`useEffect` in `App.tsx`). Loaded with defaults merged on startup.

---

## Application Flow

```
intake (ChatIntake)
    ↓  onGoalReady(goal)         — clears any existing plan from state
plan   (PlanView)
    ↓  onAccept(plan)            — sets plan.acceptedAt, transitions to dashboard
dashboard (Dashboard)
```

Tab gating: Plan tab requires `state.goal`. Dashboard tab requires `state.goal && state.plan?.acceptedAt`. Draft plans (no `acceptedAt`) do not unlock the Dashboard tab. The `CheckInScheduler` is always mounted but only active in the `dashboard` phase.

---

## File-by-File Breakdown

### `src/App.tsx`
Root component. Owns all state. Passes slices down as props (no context/store). Key responsibilities:
- Load/save state
- Route between phases via `state.phase`
- `onGoalReady` — clears `plan: undefined` so PlanView always generates fresh
- `onDraftPlanUpdate` — saves in-progress plan steps to state without `acceptedAt`
- Bridge `CheckInScheduler` → `Dashboard` via `pendingProactiveAt` (integer timestamp, increments on each scheduler fire)
- On reset, calls `deleteIntakeDoc(goal.intakeDocId)` to clean up embedded viarag document

### `src/types.ts`
All TypeScript interfaces and the `DEFAULT_SETTINGS` constant. Single source of truth for the data model.

### `src/storage.ts`
- `loadState()` / `saveState()` — localStorage CRUD with safe parse + defaults merge
- `resetState()` — wipes storage and returns empty state
- `uid(prefix)` — generates random IDs (`Math.random().toString(36)` + `Date.now().toString(36)`)

### `src/llm.ts`
All LLM calls. Uses a lazy-initialised singleton `ViaRAGClient`. All generation goes through `direct(prompt)` → `unwrap(response)`. JSON arrays are parsed via `extractJsonArray<T>()` which finds the outermost balanced `[...]`, tolerating surrounding prose and code fences.

| Export | Purpose | LLM behaviour |
|--------|---------|---------------|
| `coachNextTurn(history)` | Intake coaching: one question at a time | Emits `<READY>` token when SMART dimensions are complete |
| `extractSmart(history)` | Converts full intake chat → structured `SmartFields` + `smartStatement` | Returns JSON object via `extractJson<T>()` |
| `embedIntakeChat(history, goalId)` | Embeds full chat transcript in viarag vector store | Returns `doc_id`; tagged with `{ goalId, type: 'intake-chat' }` |
| `deleteIntakeDoc(docId)` | Deletes embedded intake document from viarag on reset | Best-effort, non-fatal |
| `generatePlan(goal, history)` | Creates 4–8 `PlanStep[]` using SMART fields + full verbatim transcript | Returns JSON array; `directQuery` only |
| `coachReplyOnTrack({history, goal, plan, proactive})` | Dashboard coaching (proactive or reactive) | Emits `<REVISE>` token to signal plan revision needed |
| `suggestRevision({smartStatement, blocker, remainingSteps})` | Replaces non-done steps with AI-revised steps | Returns JSON array |
| `hasApiKey()` | Boolean check for UI warning banner | — |

**Token protocol:**
- `<READY>` — intake coach signals all SMART dimensions gathered
- `<REVISE>` — track coach signals the plan should be revised

**Key design decision:** `generatePlan` uses `directQuery` with the full intake transcript injected verbatim in the prompt. RAG retrieval (`client().query()`) was tried but dropped — the critical scheduling details users provide (e.g. "3 level 2 edits per day") were given after the SMART framework closed and were not reliably surfaced by semantic search. Full transcript injection is deterministic and context-complete.

### `src/components/ChatIntake.tsx`
Phase 1 UI. Chat bubble interface. Sends user messages → `coachNextTurn`. When coach emits `<READY>`, surfaces "Finalize SMART goal" button → calls `extractSmart` then `embedIntakeChat` (non-fatal if it fails) → lifts `Goal` (with optional `intakeDocId`) to App.

### `src/components/PlanView.tsx`
Phase 2 UI. Accepts `goal`, `chat`, and `initialPlan` props. Auto-generates plan on mount if `steps.length === 0`. On every step change, calls `onDraftUpdate` to persist draft to App state.

**Drag-to-reorder:** Steps are `draggable`. `dragIndex` / `dragOverIndex` refs track source and target; `onDragEnd` calls `moveStep(from, to)` which splices the array. Step numbers auto-update from array index.

User can add/remove/edit/reorder steps then "Accept plan" → sorts by `targetDate`, sets `acceptedAt`, lifts `Plan` to App.

### `src/components/Dashboard.tsx`
Phase 3 UI. Three sub-panels:
1. **Timeline** — plan steps with status dropdowns, ICS export, mailto, AI revise
2. **Coach chat** — chat bubbles + composer + "Check in now" button
3. **Settings** — check-in rate slider, notification permission request

Handles both proactive check-ins (via `pendingProactiveAt` prop) and user-initiated messages. If `coachReplyOnTrack` returns `suggestsRevision: true`, shows an "Apply AI revision" prompt.

**Check-in context:** `coachReplyOnTrack` injects today's date, full `smartStatement`, all plan steps with current statuses, and the last 16 chat turns. No RAG needed — the plan itself is the context.

### `src/components/CheckInScheduler.tsx`
Renderless component (`return null`). Three exports:

- **`CheckInScheduler`** (component) — Poisson-sampled timer. Delay = $-\ln(U) / \lambda$ clamped to [30s, 6h]. Persists next-fire ISO string in App state. Re-arms after each fire.
- **`ensureNotificationPermission()`** — requests browser notification permission
- **`fireChatNotification(body)`** — fires a `Notification` only when tab is hidden

### `src/utils/ics.ts`
Generates RFC 5545 `.ics` calendar files from a `Plan`. Each `PlanStep` becomes an all-day `VEVENT` (date sliced to `YYYY-MM-DD`) with a 9-hour-before `VALARM`. `downloadIcs()` creates a Blob URL and triggers a fake `<a>` click.

### `src/styles.css`
Dark-only design system. CSS custom properties on `:root`. Notable classes: `.card`, `.chat`, `.bubble`, `.bubble.user`, `.bubble.assistant`, `.step`, `.step.done/blocked/in_progress`, `.composer`, button variants (`primary`, `secondary`, `ghost`, `danger`).

---

## LLM Prompt Architecture

### Intake (`COACH_SYSTEM`)
- System-style preamble prepended to each turn's transcript
- Instructs coach to ask ONE question per turn, ≤60 words
- `<READY>` token on its own line signals completion

### Plan Generation
- Prompt includes: today's date, output format rules, all 5 SMART fields, and the **full verbatim intake transcript**
- The transcript instruction explicitly tells the model to honour every specific quantity, schedule, or level breakdown — and not to paraphrase or re-derive structure
- Uses `directQuery` only; `daysFromNow` offsets are converted to local `YYYY-MM-DDTHH:MM` strings at 09:00

### Tracking (`TRACK_SYSTEM`)
- Injects today's date, full `smartStatement`, and numbered plan summary (status + title + date + description)
- Injects last 16 chat turns
- Two directive modes: **proactive** (check-in prompt) vs **reactive** (respond to user message)
- `<REVISE>` token triggers plan revision UI

---

## PWA Configuration (`vite.config.ts`)

- `registerType: 'autoUpdate'` — service worker auto-updates silently
- `StaleWhileRevalidate` for all static assets (JS/CSS/HTML/SVG/fonts)
- `navigateFallback: '/index.html'` — SPA offline support
- Manifest: standalone display, `#4f46e5` theme, dark background `#0b1020`

---

## Known Patterns & Quirks

- **No router** — phase is a string in state, tabs call `setState` directly
- **`pendingProactiveAt` bridge** — App can't call Dashboard methods directly; instead it increments a timestamp that Dashboard watches via `useEffect`
- **`checkIns: CheckInLog[]`** — exists in the data model and storage but is never written to by the current UI (reserved for future use)
- **`extractJson<T>`** — used for single JSON objects (e.g. `extractSmart`); strips code fences then finds first balanced `{...}`
- **`extractJsonArray<T>`** — used for all JSON arrays (plan steps); finds outermost balanced `[...]` by bracket counting, more robust than `extractJson` for array output
- **`uid()`** uses `Math.random()` — not cryptographically secure, fine for local IDs
- **Tab is hidden check** in `fireChatNotification` — notification only fires when the user isn't already looking at the app
- **Date handling** — all new dates are stored as `YYYY-MM-DDTHH:MM` (local time, 09:00 default). `fmt()` in Dashboard parses date-only strings via `new Date(year, month-1, day)` to avoid UTC→local shift. ICS generation slices to date-only before stripping hyphens
- **`intakeDocId` on Goal** — populated after `embedIntakeChat()` during finalization. Currently not used for plan generation (direct transcript injection is used instead) but preserved for potential future RAG features


---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite 5 + `@vitejs/plugin-react` |
| PWA | `vite-plugin-pwa` (Workbox, auto-update, standalone) |
| LLM | `viarag` npm SDK — `ViaRAGClient.directQuery()` |
| Storage | `localStorage` key `ipa.state.v1` |
| Styling | Single CSS file, dark theme, no component library |
| Calendar | `.ics` file generation + `mailto:` link |

**Dev server:** `npm run dev` → `localhost:5173`  
**Env var required:** `VITE_VIARAG_API_KEY` in `.env.local`

---

## App State & Data Model (`src/types.ts`)

```
AppState
├── phase: 'intake' | 'plan' | 'dashboard'
├── goal?: Goal
│   ├── id, rawWish, createdAt
│   ├── smart: { specific, measurable, achievable, relevant, timeBound }
│   └── smartStatement: string          ← single LLM-composed goal sentence
├── plan?: Plan
│   ├── id, goalId, acceptedAt
│   └── steps: PlanStep[]
│       └── { id, title, description, targetDate (YYYY-MM-DD), status }
│           status: 'pending' | 'in_progress' | 'done' | 'blocked'
├── checkIns: CheckInLog[]              ← currently unused by UI (reserved)
├── chat: ChatTurn[]                    ← shared across all phases
├── nextCheckInAt?: string              ← ISO timestamp, persisted for reload survival
└── settings: Settings
    ├── checkInRatePerHour: number      ← default 1.0 (Poisson λ)
    └── notificationsRequested: boolean
```

State is saved to localStorage on every change (`useEffect` in `App.tsx`). Loaded with defaults merged on startup.

---

## Application Flow

```
intake (ChatIntake)
    ↓  onGoalReady(goal)
plan   (PlanView)
    ↓  onAccept(plan)
dashboard (Dashboard)
```

Tabs are gated: Plan tab requires a goal; Dashboard tab requires both. The `CheckInScheduler` is always mounted but only active in the `dashboard` phase.

---

## File-by-File Breakdown

### `src/App.tsx`
Root component. Owns all state. Passes slices down as props (no context/store). Key responsibilities:
- Load/save state
- Route between phases via `state.phase`
- Bridge `CheckInScheduler` → `Dashboard` via `pendingProactiveAt` (integer timestamp, increments on each scheduler fire)

### `src/types.ts`
All TypeScript interfaces and the `DEFAULT_SETTINGS` constant. Single source of truth for the data model.

### `src/storage.ts`
- `loadState()` / `saveState()` — localStorage CRUD with safe parse + defaults merge
- `resetState()` — wipes storage and returns empty state
- `uid(prefix)` — generates random IDs (`Math.random().toString(36)` + `Date.now().toString(36)`)

### `src/llm.ts`
All LLM calls. Uses a lazy-initialised singleton `ViaRAGClient`. Every call goes through `direct(prompt)` → `unwrap(response)`.

| Export | Purpose | LLM behaviour |
|--------|---------|---------------|
| `coachNextTurn(history)` | Intake coaching: one question at a time | Emits `<READY>` token when SMART dimensions are complete |
| `extractSmart(history)` | Converts full intake chat → structured `SmartFields` + `smartStatement` | Returns JSON object |
| `generatePlan(smartStatement)` | Creates 4–8 `PlanStep[]` from the SMART goal | Returns JSON array with `daysFromNow` offsets |
| `coachReplyOnTrack({history, goal, plan, proactive})` | Dashboard coaching (proactive or reactive) | Emits `<REVISE>` token to signal plan revision needed |
| `suggestRevision({smartStatement, blocker, remainingSteps})` | Replaces non-done steps with AI-revised steps | Returns JSON array |
| `hasApiKey()` | Boolean check for UI warning banner | — |

**Token protocol:**
- `<READY>` — intake coach signals all SMART dimensions gathered
- `<REVISE>` — track coach signals the plan should be revised

### `src/components/ChatIntake.tsx`
Phase 1 UI. Chat bubble interface. Sends user messages → `coachNextTurn`. When coach emits `<READY>`, surfaces "Finalize SMART goal" button → calls `extractSmart` → lifts `Goal` to App.

### `src/components/PlanView.tsx`
Phase 2 UI. Auto-generates plan on mount (if no existing plan). Renders steps as editable inline cards (title, description, date). User can add/remove/edit steps then "Accept plan" → lifts `Plan` to App.

### `src/components/Dashboard.tsx`
Phase 3 UI. Three sub-panels:
1. **Timeline** — plan steps with status dropdowns, ICS export, mailto, AI revise
2. **Coach chat** — chat bubbles + composer + "Check in now" button
3. **Settings** — check-in rate slider, notification permission request

Handles both proactive check-ins (via `pendingProactiveAt` prop) and user-initiated messages. If `coachReplyOnTrack` returns `suggestsRevision: true`, shows an "Apply AI revision" prompt.

### `src/components/CheckInScheduler.tsx`
Renderless component (`return null`). Three exports:

- **`CheckInScheduler`** (component) — Poisson-sampled timer. Delay = $-\ln(U) / \lambda$ clamped to [30s, 6h]. Persists next-fire ISO string in App state. Re-arms after each fire.
- **`ensureNotificationPermission()`** — requests browser notification permission
- **`fireChatNotification(body)`** — fires a `Notification` only when tab is hidden

### `src/utils/ics.ts`
Generates RFC 5545 `.ics` calendar files from a `Plan`. Each `PlanStep` becomes an all-day `VEVENT` with a 9-hour-before `VALARM`. `downloadIcs()` creates a Blob URL and triggers a fake `<a>` click.

### `src/styles.css`
Dark-only design system. CSS custom properties on `:root`. Notable classes: `.card`, `.chat`, `.bubble`, `.bubble.user`, `.bubble.assistant`, `.step`, `.step.done/blocked/in_progress`, `.composer`, button variants (`primary`, `secondary`, `ghost`, `danger`).

---

## LLM Prompt Architecture

### Intake (`COACH_SYSTEM`)
- System-style preamble prepended to each turn's transcript
- Instructs coach to ask ONE question per turn, ≤60 words
- `<READY>` token on its own line signals completion

### Tracking (`TRACK_SYSTEM`)
- Injects today's date, full `smartStatement`, and numbered plan summary (status + title + date + description)
- Injects last 16 chat turns
- Two directive modes: **proactive** (check-in prompt) vs **reactive** (respond to user message)
- `<REVISE>` token triggers plan revision UI

---

## PWA Configuration (`vite.config.ts`)

- `registerType: 'autoUpdate'` — service worker auto-updates silently
- `StaleWhileRevalidate` for all static assets (JS/CSS/HTML/SVG/fonts)
- `navigateFallback: '/index.html'` — SPA offline support
- Manifest: standalone display, `#4f46e5` theme, dark background `#0b1020`

---

## Known Patterns & Quirks

- **No router** — phase is a string in state, tabs call `setState` directly
- **`pendingProactiveAt` bridge** — App can't call Dashboard methods directly; instead it increments a timestamp that Dashboard watches via `useEffect`
- **`checkIns: CheckInLog[]`** — exists in the data model and storage but is never written to by the current UI (reserved for future use)
- **`extractJson<T>`** — strips code fences then finds the first balanced `{...}` or `[...]` in the raw LLM response; tolerant of surrounding prose
- **`uid()`** uses `Math.random()` — not cryptographically secure, fine for local IDs
- **Tab is hidden check** in `fireChatNotification` — notification only fires when the user isn't already looking at the app
