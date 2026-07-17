# IK Chains — QA & UX Pass

Scope of this pass: a UI/UX cleanup (Owlbear-native theming, icon set, no emoji,
accessibility, keyboard-shortcut safety) plus a senior-QA stress test of the
settings and the extension's interaction with stock Owlbear Rodeo features.

The solver, model, and persistence layers are exercised by the unit suite
(`npm test`, 52 tests). This document records the manual/analytical review of the
runtime behavior that unit tests can't reach, the fixes made, and the residual
limitations worth knowing about.

---

## 1. UI / UX changes

| Area | Before | After |
| --- | --- | --- |
| Theming | Hard-coded gray borders, `color-scheme: light dark` only | Colors driven by Owlbear's live theme (`OBR.theme.getTheme` / `onChange`) mapped to CSS custom properties; re-tints on theme change with no reload. Dark-room fallbacks baked into CSS. |
| Icons | Unicode glyphs (`⚓`, `↶`, `↷`, `✕`, `›`) | Inline [Phosphor](https://phosphor-icons.com) (MIT) SVGs: anchor, undo, redo, close, caret. No Lucide anywhere (confirmed by grep). |
| Emoji / emoticons | Anchor emoji `⚓` in sidebar and README | Removed everywhere in `src/` and README. Remaining `—`/`→`/`·` are standard typography, not emoji. |
| Toolbar/tool icons | Custom line-art SVGs (`icon.svg`, `pose.svg`, `build.svg`) | Kept — already original artwork, not Lucide/emoji. |

### Owlbear brand / licensing

No Owlbear brand assets, fonts, or proprietary icons are bundled. Theme colors
are read at runtime through the public SDK theme API (the sanctioned way to match
a room's look), so the sidebar inherits whatever palette the room uses rather
than copying Owlbear's assets.

---

## 2. Accessibility

- **Icon-only buttons** (undo/redo, remove node, delete preset, dismiss notice)
  now carry descriptive `aria-label`s; decorative SVGs are `aria-hidden` +
  `focusable="false"`.
- **Keyboard focus**: added `:focus-visible` outlines (theme-accent colored) for
  buttons, inputs, and focusable elements. Mouse clicks don't trigger the ring.
- **Status messages**: the notice banner is a `role="status"` `aria-live="polite"`
  region with a real dismiss **button** — previously it was a click-anywhere
  `<p>` that keyboard users couldn't dismiss.
- **Form labels**: every checkbox/number input has an associated label (explicit
  `htmlFor`/`id` on chain settings, implicit wrapping labels on node controls).
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` neutralizes
  transitions/animations.
- **Contrast**: secondary text now uses the theme's `text.secondary` token
  instead of a flat `opacity: 0.6`, so it tracks the room's intended contrast.

---

## 3. Keyboard shortcuts — no conflict with Owlbear

The extension **registers no keyboard shortcuts or global key listeners**
(verified: no `keydown`/`addEventListener`/`shortcut`/`onKeyDown` in `src/`).
Tool modes are activated by clicking the toolbar, not by hotkeys. Owlbear's stock
shortcuts (e.g. select `S`, measure, move, `Z`/`Y` undo, delete) are therefore
untouched. Undo/Redo in the sidebar are on-screen buttons scoped to rig edits —
they do not hijack the browser/OBR `Ctrl+Z`.

> If keyboard shortcuts are added later, avoid Owlbear's reserved single-key tool
> shortcuts and `Ctrl/Cmd+Z/Y`; prefer scoping any handler to the sidebar iframe.

---

## 4. Stress test — settings & edge cases

### Token count / size

| Scenario | Result |
| --- | --- |
| Many small tokens packed tight | Build clicks resolve the exact clicked token via `event.target`, so packing doesn't misassign. Pose uses `event.target` first; only a pointer *miss* falls back to nearest-within-`GRAB_RADIUS` (300 units ≈ 2 default cells). See limitation below. |
| One huge token | Solver works on token **centers**; token art size is irrelevant to the math. No issue. |
| Several huge tokens | Same — centers only. Rest lengths captured at build time from center spacing. |
| Large token image files | Positions/rotations live in scene metadata; image byte size never enters the solver. No impact. |
| Overlapping / coincident tokens | Zero rest length is handled: `solveChain` returns the chain unchanged when total length ≤ 0, and rigid-carry rotation is skipped when a bone is degenerate (`dist > 1e-9` guard). NaN can never be written — `applyPose` only commits finite coordinates. Covered by the coincident-tokens unit test. |
| Deeply nested / long chains | FABRIK is linear per solve; capped iterations (12). Off-path subtrees carried rigidly. |
| Many chains in one scene | Connector overlay does a **single** scene scan for all chains and is GM-only + serialized (coalesced refreshes), so N chains ≠ N scans. |

### Inverted bend limit (fixed)

Typing `min° > max°` in the sidebar previously collapsed the joint onto a single
angle (the clamp degenerated). The solver now orders the bounds, so an inverted
range behaves like the equivalent forward range instead of locking. Regression
test added.

### Auto-rotate / rotation offset

Offset accepts any number and is normalized mod 360 before being written; a
non-finite bone angle falls back to 0 (no NaN into `item.rotation`).

---

## 5. Interaction with stock Owlbear features

| Feature | Behavior | Status |
| --- | --- | --- |
| **Hidden tokens** | The connector overlay lives on the shared `DRAWING` layer (visible to all). It now **skips any token with `visible === false`**, so a GM's hidden token no longer has its position betrayed by a bone/handle drawn over it. Posing math also tolerates a player not being able to see a hidden node (its target is filtered out gracefully). | **Fixed (info-leak)** |
| **Fog of war** | Fog is its own layer; `isToken` only accepts `CHARACTER/MOUNT/PROP/ATTACHMENT`, so fog is never picked up as a riggable node. Posing writes token position/rotation only and never edits fog. | OK |
| **Drawings / drawn pathways** | Build/pose ignore `DRAWING`-layer items (not token layers). Our own overlay items are `locked(true)` + `disableHit(true)`, so they can't be grabbed, moved, or accidentally selected while drawing. | OK |
| **Negative-scale "flip"** | Flipping a token sets a negative `scale`. The solver reads/writes **position and rotation only** — `scale` is never touched — so flips are fully preserved through posing. (Auto-rotate still orients by bone angle; mirrored art may need a rotation-offset tweak, which is expected.) | OK |
| **Token locking (OBR)** | Independent of our per-node `lock`. Our permission checks run in tool logic regardless of Owlbear item permissions. | OK |
| **Grid scaling / units** | Rest lengths are captured in scene units at build time, so any grid scale is honored. `Recalibrate` re-measures if tokens are rearranged. | OK |
| **Multiplayer sync** | Chains/presets are scene metadata → synced to all clients. Pruning of deleted tokens and connector rebuilds are **GM-single-writer** to avoid last-write-wins clobbering. Posing streams via the interaction API and writes once on release. | OK |
| **Scene switch / reload** | Empty item set during a scene switch is treated as "not populated," not "all tokens deleted," so valid chains aren't wiped. Overlay rebuilds on `scene.onReadyChange`. | OK |
| **Delete a token** | Pruned from its chain by the GM; root deletion removes the chain, interior deletion re-parents children. | OK |
| **Context menu** | `Set as IK Root` / `Remove from IK Chain` are GM-filtered and layer-agnostic within token layers. | OK |

---

## 6. Residual limitations (by design / low risk)

1. **`GRAB_RADIUS` is a fixed 300 scene units.** It only applies on a pointer
   *miss* in Pose mode (direct hits use `event.target`). With very small tokens
   spaced under ~1.5 cells apart, a near-miss could resolve to a neighbor. A
   direct click on the intended token always wins. Not scaled to grid/token size
   — left as-is to avoid changing pose behavior; documented for future tuning.
2. **Manually deleting the overlay** (e.g. GM "clear drawings") won't redraw it
   until the next chain-metadata change or scene-ready event. Toggling
   *Show connector lines* forces a rebuild.
3. **Sidebar undo/redo is per-session** and not shared between clients — this is
   intentional (documented in the README).

---

## 7. Verification

- `npm run typecheck` — clean
- `npm test` — 52 passing (incl. new inverted-constraint regression)
- `npm run build` — production build succeeds
