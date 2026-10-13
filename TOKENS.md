# Tokens

Renderer uses a dark designer theme for Electron. Website uses a separate light theme.

## Renderer (Electron desktop) — `src/renderer/src/assets/tokens.css`

Single source for the desktop. Imported first in `src/renderer/src/main.tsx` before `main.css`.

- Dark base: `--background 240 10% 3.9%` (#0a0b0f), `--card 232 12% 9%` (#12141a), `--foreground 240 6% 94%`.
- Brand is purple: `--primary 263 70% 60%` (#8b5cf6), `--primary-hover 263 70% 68%` (#a78bfa). No lime.
- Sidebar maps to `--sidebar` (= card), overlay mint stays `--overlay-ok #8DF0C4`.
- Radius `--radius 0.75rem` with `lg/md/sm` derived; typography `--text-*` + `--font-sans/mono/display`.
- Alpha scale `--alpha-10..90` for glass; legacy aliases `--bg-deep/--accent/--bright-purple` kept for back-compat.
- `primitives.css` holds drill (0.24s), glass, skeleton shimmer, focus-ring, reduced-transparency fallback.

Any new color/spacing/radius should go through these vars, not hardcoded `rgba(139,92,246` literals.

## Website — `website/src/index.css`

Light navy theme, Tailwind `hsl(var(--primary) 215 64% 28%)` etc. **Do not import renderer tokens**.

Contract: desktop and website token files never cross-import.
