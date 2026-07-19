# Lessons carried forward

Hard-won correctness / performance / stability / security findings from the
extension's earlier QA and hardening passes. The feature surface was pared down
(see the git tag `v0.6-full` for the full version), but these are properties of
the *runtime interaction with Owlbear*, not of the cut features, so they are
preserved here and baked into the current code. Don't regress them.

## Stability — never write NaN / degenerate transforms

- **Only finite coordinates are committed.** `applyPose` (`src/obr/tool.ts`) writes
  `item.position` only when both components are `Number.isFinite`. A NaN that ever
  reached the scene would corrupt a token's transform permanently.
- **Zero-length chains don't collapse.** `solveChain` (`src/ik/fabrik.ts`) returns
  the input unchanged when total rest length ≤ 0 (coincident tokens), instead of
  straightening every node onto the root.
- **Degenerate bones skip rotation.** The rigid tail carry in `src/ik/pose.ts`
  computes an incoming-bone rotation only when both the old and new bones have
  length > 1e-9 (`atan2(0,0)` is 0 and would otherwise inject a bogus turn).
- **Rotation is normalized and NaN-guarded.** `radToObrDeg` (`src/obr/scene.ts`)
  maps a non-finite bone angle to 0 and normalizes the result into `[0, 360)`.

## Stability — multiplayer sync & scene lifecycle

- **Empty item set ≠ everything deleted.** In `background.ts`, the prune handler
  returns early when `items.length === 0`, because an empty set means the scene
  isn't populated yet (mid scene-switch). Pruning there would wipe valid chains.
- **GM single-writer.** Only the GM prunes/persists (`background.ts`), so N clients
  don't all issue the same last-write-wins metadata write and clobber each other.
- **Cached chain map + fast-path.** The hot `items.onChange` handler reads a cached
  map and skips entirely unless a referenced token actually went missing — no
  fetch/diff of the whole map on every scene mutation.

## Performance — real-time posing stays cheap

- **FABRIK is capped.** `solveChain` iterates at most `iterations` (default 12) and
  is linear per solve.
- **Drags stream, the scene is written once.** Posing goes through
  `OBR.interaction.startItemInteraction`; only on release does
  `OBR.scene.items.updateItems` persist the final positions (`tool.ts`).
- **Start/cancel race guard.** `starting` / `cancelledDuringStart` in `tool.ts`
  tear down an interaction that was ended while async setup was still pending,
  instead of leaking a live interaction for ~30s.

## Correctness / security

- **Layer filter.** `isToken` (`src/obr/scene.ts`) accepts only
  CHARACTER / MOUNT / PROP / ATTACHMENT, so fog and drawings are never treated as
  riggable — and build-from-selection filters the selection through it.
- **`scale` is never touched.** The solver reads/writes position + rotation only, so
  a token's negative-scale flip survives posing.
- **Exact token binding.** Building uses the actual selected item ids; posing uses
  `event.target` first and only falls back to nearest-within-`GRAB_RADIUS` on a
  pointer miss — packing tokens tightly never misassigns a direct hit.
- **GM-only gate.** The tool icon is role-filtered to GM and `onPoseDragStart`
  re-checks the role; the context menu is GM-filtered.

## UX — keep the top-center toolbar clear

- **No `OBR.notification` calls.** Owlbear renders its own messaging in the
  top-center area; extension feedback lives in the popover (the live chain list +
  an inline status line), not in toasts that overlap it.
- **One tool, one mode.** Posing needs a canvas tool, but there is no secondary
  mode-button row — building and settings are in the popover, not extra toolbar
  buttons.
- **Exactly one keyboard shortcut, via the SDK — not a raw listener.** The tool
  has a single tool-activation `shortcut` (`POSE_SHORTCUT`, `src/obr/constants.ts`)
  so you can jump to posing without hunting the toolbar. It uses Owlbear's
  sanctioned `shortcut` field (which OBR arbitrates), **not** a global `keydown`
  listener that could hijack the room's keys. The letter is chosen clear of
  Owlbear's built-in tool keys (W/F/D/M/Q/N) and its fog/draw sub-mode keys; a bare
  letter is never a browser shortcut (those need Ctrl/Cmd/Alt). Live drag-posing
  can't be attached to the built-in Move tool — the SDK routes drag events only to
  a custom tool's active mode — so the hotkey is the friction-reducer, not a
  Move-tool hook.

## Deployment gotcha — base path on every asset URL

The site is a GitHub Pages *project* site served from `/IK-Extension/`, so a bare
`/icon.svg` 404s (it did once, blanking the tool/menu icons). Every asset URL must
carry the prefix:

- Vite `base: "/IK-Extension/"` (`vite.config.ts`),
- the manifest's `icon` / `action.popover` / `background_url` (`public/manifest.json`),
- in-code icons through the `asset()` helper (`src/obr/constants.ts`), which uses
  `import.meta.env.BASE_URL`.

## Deliberately absent (don't naively re-add)

- **On-canvas connector/skeleton overlay.** An earlier version drew bones on the
  shared DRAWING layer. It can **leak the position of a GM's hidden token** to
  players. If ever re-added: skip any item with `visible === false`, and set the
  overlay items `locked(true) + disableHit(true)` so they can't be grabbed.
- **`GRAB_RADIUS` is a fixed 300 scene units** and only applies on a pointer miss.
  With very small tokens under ~1.5 cells apart, a near-miss could resolve to a
  neighbor; a direct click always wins. Left unscaled by design.
