# AgentGate Design System: "Paper Ledger"

A calm, editorial, trustworthy look for a control plane: warm paper, ink text, one confident blue, and status colors that mean something. It should feel like a well-kept ledger of what your AI agents are allowed to do.

**Three words to judge every decision by:** *precise, calm, accountable.*

---

## 1. Color

### Roles (light theme)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#F6F5F1` | App background (warm paper) |
| `--surface` | `#FFFFFF` | Cards, sidebar, tables, inputs |
| `--raised` | `#FAF9F5` | Table header, row hover, subtle fills |
| `--elev` | `#EEF0F7` | Selected rows, chips, secondary buttons, active nav |
| `--line` | `#E4E1D8` | Default borders and dividers |
| `--line-strong` | `#CFCBC0` | Input and secondary button borders |
| `--text` | `#12151F` | Headings and body |
| `--text-2` | `#4B5266` | Secondary text |
| `--text-3` | `#656C81` | Captions, helper text, table headers (the dimmest allowed) |
| `--primary` | `#2F55D4` | Main button, active state, links, focus ring |
| `--primary-hover` | `#2445B5` | Hover |
| `--primary-pressed` | `#1C3796` | Pressed |
| `--ink` | `#12151F` | Logo mark, strongest brand surface |
| `--allowed` | `#0B7A55` | Allowed / success |
| `--pending` | `#8F5A00` | Needs approval / medium risk |
| `--denied` | `#B42A2A` | Denied / high risk / destructive |

### Usage ratio
About 75% paper and white, 20% ink text and lines, 4% primary, 1% status colors. If a screen feels colorful, you've used too much.

### Rules
1. **Primary is only for the single main action, links, the active state and focus.** One primary button per screen.
2. **Status colors are only for status.** Never use green, amber or red for decoration or branding.
3. **Every status is a tinted pill with text and a dot.** Meaning never depends on color alone.
4. **Layer surfaces instead of adding borders.** Paper, white card, raised row, selected row.
5. **No gradients, no glows.** The only glow is the focus ring.

### Status mapping for AgentGate

| Concept | Badge | Color |
|---|---|---|
| Allowed, policy passed, healthy | Allowed | `--allowed` |
| Needs approval, medium risk, warning | Needs approval / Medium | `--pending` |
| Denied, high risk, failed, destructive | Denied / High | `--denied` |
| Informational, new, selected | Info | `--primary` |

### Contrast (WCAG, calculated)
- Text on paper: 16.7:1. Text on white: 18.2:1.
- Secondary text on white: 7.8:1.
- Lowest text (`--text-3`) on white 5.2:1, on paper 4.8:1, on selected rows 4.6:1. All pass AA (4.5:1).
- Primary on white 6.2:1. White on primary 6.2:1.
- Status text on its own tint: allowed 4.6:1, pending 5.0:1, denied 5.3:1. All pass AA.

### Dark theme
Same roles, new values, defined in the token file (`data-theme="dark"`). Use it for the product when users want it; the marketing site and docs stay light.

---

## 2. Typography

| Role | Font | Where |
|---|---|---|
| UI and body | **Instrument Sans** (400, 500, 600) | Everything in the product |
| Code, scopes, IDs, logs, numbers in tables | **JetBrains Mono** (400, 500) | Chips, traces, API keys, timestamps |
| Editorial | **Fraunces** (500, italic 500) | Marketing headlines, page intros, large empty states only |

Never use Fraunces inside tables, forms or buttons. Use `font-variant-numeric: tabular-nums` for every number column.

### Scale (size / line-height)

| Name | Size | Use |
|---|---|---|
| 2xs | 11 / 16 | Eyebrow labels, uppercase, 0.08em tracking, `--text-3` |
| xs | 12 / 16 | Badges, chips, captions |
| sm | 13 / 20 | Table text, helper text |
| base | 14 / 22 | Default body |
| md | 16 / 24 | Card titles |
| lg | 20 / 28 | Section headings |
| xl | 24 / 32 | Panel titles, display intros |
| 2xl | 30 / 38 | Page titles (Instrument Sans 600, -0.02em) |
| 3xl | 40 / 46 | Marketing sub-headlines |
| 4xl | 56 / 60 | Marketing headlines (Fraunces, -0.03em) |
| 5xl | 72 / 74 | Landing hero (Fraunces, -0.03em) |

### The editorial move
In a headline, set one word in Fraunces italic in `--primary`. Example: "Every tool your agents can reach, *governed*." Use it once per page.

### Loading fonts in Next.js
```ts
// app/layout.tsx
import { Instrument_Sans, JetBrains_Mono, Fraunces } from "next/font/google";

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });
const display = Fraunces({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-fraunces", display: "swap" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```
Then import `agentgate-tokens.css` once in your global stylesheet.

---

## 3. Spacing, shape, motion

- **Spacing:** 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96.
- **Radius:** 6px chips, 8px buttons, inputs and nav items, 12px cards and tables, pill for badges.
- **Shadows:** light theme only, extremely subtle (`--shadow-card`). Dark theme uses lines and surface layers instead.
- **Motion:** 120-180ms ease-out. Nothing bouncy. Respect `prefers-reduced-motion`.
- **Layout:** sidebar 248px, content max width 1280px, page padding 40px (24px on mobile).

---

## 4. Components

**Buttons:** one primary per screen. Secondary for the second action, ghost for tertiary, danger only for destructive confirmations.
*Example, Tool registry:* primary "Register tool"; secondary "Test risky action".

**Status badge:** pill, 12px/600, tint background, colored text, 6px dot. Same structure for every status in the product.

**Scope chip:** mono 12px on `--elev` with a `--line` border. Neutral, never colored.

**Table:** eyebrow-style header on `--raised`; 14px vertical row padding; row title in 600 with a 13px `--text-3` description beneath; hover `--raised`; selected `--elev`. Wide tables scroll horizontally inside their own container.

**Navigation:** active item uses `--elev` background and `--text`. No colored side bar. A count badge (amber tint) shows pending approvals.

**Cards:** white on paper, 1px `--line`, 12px radius.

**Forms:** 10px/12px padding, `--line-strong` border, focus ring in primary.

**Empty states:** the one place for a large Fraunces line plus one primary action.

**Logs and traces:** JetBrains Mono 12-13px on `--surface`, timestamps in `--text-3`, status shown with the standard badge.

---

## 5. Brand basics

- **Logo mark:** a simple gate or shield glyph in `--ink` on paper (or paper on ink). Keep it one color. Wordmark "AgentGate" in Instrument Sans 600.
- **Favicon and app icon:** the mark on an ink square.
- **Voice:** plain, exact, calm. "Denied by policy: payments:refund" beats "Oops, something went wrong."
- **Marketing site:** light theme, large Fraunces headline with one italic word, product screenshots in a dark or light frame on paper, lots of whitespace.

---

## 6. Do and don't

**Do**
- Show real data in tables (names, scopes, times), not placeholders
- Pair every status color with a label and a dot
- Keep the primary color rare so it stays meaningful
- Use mono for anything a user might copy

**Don't**
- Use gradients, glows, emoji, or neon accents
- Use Fraunces in dense UI
- Put two primary buttons on one screen
- Use `--text-3` for anything smaller than 12px or lighter than the spec

---

## 7. Before you launch commercially
- Search the name "AgentGate" across the web, app stores, domains (.com, .ai, .dev) and trademark databases. It is a generic name and may already be taken.
- Design a proper logo (a freelance designer or a small brand pass is worth it).
- Re-check contrast whenever you change a color. The values here were calculated, not eyeballed.