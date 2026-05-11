# Intelligent Progress Assistant

A small PWA that turns a one-line wish into a **SMART goal**, generates a step-by-step plan with target dates, nudges you with **proactive check-ins**, and lets you export the timeline to **Outlook** as `.ics`. LLM coaching is powered by [viarag.ai](https://viarag.ai) via the `viarag` SDK; all user data stays in the browser (`localStorage`). Installable as a PWA, works offline after first load.

## Stack

- **Vite + React + TypeScript**
- **vite-plugin-pwa** (service worker, manifest, offline caching)
- **viarag** SDK (`directQuery`) for goal coaching, plan generation, and adaptive replanning
- **localStorage** persistence — no backend, single-user MVP
- **Browser Notification API** for backgrounded check-in nudges; in-app modal otherwise

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your sk_rag_... key
npm run dev
```

Open http://localhost:5173. To verify the PWA install + offline path, run `npm run build && npm run preview` and use Chrome/Edge's "Install app" button.

### Environment

| Var | Description |
| --- | --- |
| `VITE_VIARAG_API_KEY` | viarag.ai API key (`sk_rag_...`). Required for the AI coach, plan generation, and revision. The key is bundled into the client at build time — fine for single-user local testing, **not** for a public deploy. |

## Feature map

| PRD requirement | Where it lives |
| --- | --- |
| Structured SMART chat | [src/components/ChatIntake.tsx](src/components/ChatIntake.tsx) + [src/llm.ts](src/llm.ts) `coachNextTurn` |
| Plan + timeline | [src/components/PlanView.tsx](src/components/PlanView.tsx) + `generatePlan` |
| Review / accept / modify | Inline editing in `PlanView` (title, description, due date, add/remove) |
| Proactive check-ins | [src/components/CheckInScheduler.tsx](src/components/CheckInScheduler.tsx) + [src/components/CheckInPopup.tsx](src/components/CheckInPopup.tsx) |
| Adaptive replanning | "Revise with AI" button in [Dashboard.tsx](src/components/Dashboard.tsx) → `suggestRevision` |
| Outlook export | [src/utils/ics.ts](src/utils/ics.ts) (`.ics`) + `Email plan` mailto |
| PWA install/offline | [vite.config.ts](vite.config.ts) `VitePWA` config + [src/main.tsx](src/main.tsx) `registerSW` |
| LocalStorage persistence | [src/storage.ts](src/storage.ts) |

## How the coach works

1. **Intake** — `coachNextTurn` runs a multi-turn chat. The model is told to ask one SMART question at a time and emit a `<READY>` token when it has enough detail.
2. **Finalize** — `extractSmart` re-reads the transcript and returns a strict JSON object with the five SMART fields plus a 1-2 sentence statement.
3. **Plan** — `generatePlan` produces 4–8 steps with `daysFromNow` offsets, mapped to absolute target dates locally.
4. **Revise** — when the user logs a blocker (or any time from the dashboard), `suggestRevision` rewrites the remaining steps using the blocker note and the existing plan.

JSON output is extracted defensively (handles code fences and stray prose) so the SDK shape doesn't need a strict schema mode.

## Out of scope (MVP)

Per PRD: multi-user, auth, deep analytics, deep Outlook API integration. `.ics` export + mailto is the calendar story for now.

## License

[MIT](LICENSE).
