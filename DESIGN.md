# Design System — Spawntree

## Product Context

- **What this is:** Local dev environment orchestrator with a web admin panel
- **Who it's for:** Developers managing multiple repos, branches, and services
  on their machine
- **Space/industry:** Developer tools — peers are Vercel Dashboard, Heroku
  Dashboard, Solo
- **Project type:** Web dashboard (SPA embedded in Go binary) + CLI

## Aesthetic Direction

- **Direction:** Inherited from gitenv (sister project). Warm Industrial —
  earthy warmth from almond palette, functional precision from GitHub status
  patterns. Dark mode primary.
- **Decoration level:** Minimal — typography, spacing, and status colors do the
  work. No decorative color.
- **Mood:** Information-dense operations console. Should feel like mission
  control for your local dev stack, not a consumer app.
- **Core principle:** Color is functional, never decorative. If it doesn't
  communicate status, it shouldn't be colored.
- **Anti-patterns:** No gradients on UI elements. No colored backgrounds for
  branding. No purple-for-the-sake-of-purple. No generic card grids that look
  like every SaaS template.

## Typography

- **Display/Hero:** Hubot Sans (variable, 200-900) — GitHub's display font
- **Body/UI:** Mona Sans (variable, 200-900) — GitHub's body font
- **Data/Tables:** Mona Sans with `font-variant-numeric: tabular-nums`
- **Code/Logs:** JetBrains Mono (variable, 100-800) — industry standard for code
- **Loading:** Self-hosted `.woff2` variable font files
- **Scale:**
  - `xs`: 10-11px — log lines, timestamps, metadata
  - `sm`: 12-13px — sidebar items, service type badges, secondary labels
  - `base`: 14px — body text, buttons, form fields (most common)
  - `lg`: 18px — section headings
  - `xl`: 20px — page titles
  - `2xl`: 24px — "Right now" banner env name

## Color

### Dark Mode (primary — this is a dev tool, dark by default)

| Token             | Hex     | Usage                  |
| ----------------- | ------- | ---------------------- |
| background        | #0D1117 | Page background        |
| foreground        | #E6EDF3 | Primary text           |
| surface           | #161B22 | Cards, sidebar, panels |
| surface-secondary | #161B22 | Hover states           |
| border            | #30363D | Primary borders        |
| border-subtle     | #21262D | Card borders, dividers |
| muted             | #8B949E | Secondary text, labels |

### Functional Colors (GitHub conventions)

| Semantic | Hex (dark) | Usage                                |
| -------- | ---------- | ------------------------------------ |
| Green    | #3FB950    | Running, healthy, success            |
| Red      | #F85149    | Error, crashed, stopped, destructive |
| Orange   | #D29922    | Warning, starting, in-progress       |
| Blue     | #58A6FF    | Links, focus rings, info             |
| Gray     | #8B949E    | Offline, inactive, muted             |

### Status Dots

- `●` Green (#3FB950) — running, healthy
- `◉` Orange (#D29922) + pulse animation — starting, in-progress
- `●` Red (#F85149) — error, crashed
- `○` Gray (#8B949E, 50% opacity) — offline, stopped

### Warning Surfaces

| Component      | Background  | Border                | Text    |
| -------------- | ----------- | --------------------- | ------- |
| Warning banner | #1C1306     | #854D0E               | #D29922 |
| Error inline   | transparent | #F85149 (left border) | #F85149 |
| Success flash  | transparent | #3FB950               | #3FB950 |

## Spacing

- **Base unit:** 4px (Tailwind default)
- **Density:** Dense-comfortable. Developer tools need information density.
- **Scale:** Standard Tailwind:
  `0.5(2) 1(4) 1.5(6) 2(8) 3(12) 4(16) 5(20) 6(24) 8(32)`

## Layout

- **Approach:** Sidebar + main content, grid-disciplined
- **Sidebar:** 240px fixed (desktop), collapsible hamburger overlay
  (mobile/tablet)
- **Max content width:** None — full-width for ops dashboards
- **Breakpoints:** sm(640) md(768) lg(1024) xl(1280)
- **Border radius:**
  - `sm`: 2px — rare
  - `md`: 6px — buttons, inputs, badges (most common)
  - `lg`: 8px — cards, panels
  - `xl`: 12px — modals

### Responsive Behavior

- **Desktop (>=1024px):** Sidebar always visible. Service cards 2-4 column grid.
  Log viewer ~40% height.
- **Tablet (768-1023px):** Sidebar hidden, hamburger drawer. Service cards
  2-column. Log viewer 50% height.
- **Mobile (<768px):** Sidebar hidden, hamburger drawer. Cards stack 1-column.
  Log viewer full-width.

## Motion

- **Approach:** Minimal-functional
- **Easing:** enter `ease-out`, exit `ease-in`, move `ease-in-out`
- **Duration:** micro `100ms`, short `150ms`, medium `200ms`
- **What animates:** Status dot pulse (starting), service card highlight on
  click (150ms), log viewer auto-scroll, sidebar expand/collapse, skeleton
  loading pulse
- **What doesn't:** Page transitions, layout shifts, decorative entrances
- **Reduced motion:** Respect `prefers-reduced-motion`. Disable pulse, skip
  transitions.

## Component Library

- **Framework:** Radix UI primitives + CVA (class-variance-authority) — shadcn
  pattern
- **Styling:** Tailwind CSS with the token system above
- **Icons:** Lucide React
- **Utilities:** `tailwind-merge`, `clsx`

## Accessibility

- **Keyboard nav:** Full tab navigation. Arrow keys in sidebar tree. Enter to
  expand/navigate.
- **ARIA:** `role="tree"` for sidebar, `role="log"` for log viewer,
  `aria-live="polite"` for status updates
- **Contrast:** All text WCAG AA (4.5:1). Green on dark: 7.2:1. Red on dark:
  5.8:1.
- **Touch targets:** 44px minimum for all interactive elements
- **Screen reader:** Status dots labeled ("running", "stopped"). Service cards
  labeled with name + status.

## Decisions Log

| Date       | Decision                        | Rationale                                                                          |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-04-01 | Inherit gitenv design system    | Sister project, shared developer audience, consistent brand                        |
| 2026-04-01 | Dark mode only (v1)             | Dev tool, used in terminal context. Light mode deferred.                           |
| 2026-04-01 | Activity-first dashboard        | "Right now" banner shows most active/crashed env. The point is "what's happening." |
| 2026-04-01 | Service card click filters logs | One click from "red card" to "what went wrong."                                    |
| 2026-04-01 | Log auto-scroll with pause      | Auto-scroll ON, pauses on scroll-up, "New logs below" pill to resume.              |
| 2026-04-02 | No DESIGN.md light mode tokens  | Dark-only for v1. Light mode can reference gitenv's light tokens when added.       |
