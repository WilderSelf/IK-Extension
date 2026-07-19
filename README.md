# IK Chains — Owlbear Rodeo Extension

Rig tokens into a **2D inverse-kinematics chain** and pose them like a limb.
Pick one token as a pinned **root**, link the others outward from it, then drag
any token — the chain flexes with the root held fixed, like a tentacle, a rope,
a segmented arm, or a monster's claw.

This is the **bare-essentials** build: a single linear chain, posed in real time,
persisted and synced through the scene. It was pared down from a larger
feature set (branching, bend limits, presets, undo/redo, per-node permissions,
an on-canvas overlay); the durable engineering lessons from those passes are
recorded in [`LESSONS.md`](LESSONS.md) and baked into the code. The full-featured
version is preserved at the git tag `v0.6-full`.

## What it does

- **Build a chain from a selection.** Select tokens **root first, then outward**,
  and click **New chain from selection** in the sidebar. Bone lengths and each
  token's orientation are captured at build time.
- **Pose it.** Select the **IK Chains** tool (or press its hotkey **`K`**) and drag
  any token: the path from the root re-solves with
  [FABRIK](https://en.wikipedia.org/wiki/FABRIK) (root pinned,
  bone lengths preserved) and the tip trails rigidly. Drag the **root** to move the
  whole chain.
- **Auto-rotate.** Tokens rotate to face along their bone as the chain flexes,
  keeping the orientation you built them with.
- **Persist & sync.** Chains live in the scene's metadata, so they survive reloads
  and sync to every connected client. Deleting a token trims it (and anything past
  it) from its chain.
- **GM-only.** Building and posing are GM actions by default.

## Quick start

1. **Install** in Owlbear Rodeo → **Extensions → Add Custom Extension**, using the
   hosted manifest URL: `https://wilderself.github.io/IK-Extension/manifest.json`.
2. Open the extension's **sidebar** (its toolbar action icon).
3. On the map, select the tokens for the chain — **root first, then each token
   outward, in order** — then click **New chain from selection**.
4. Select the **IK Chains** tool in the toolbar — or press its hotkey **`K`** — and
   **drag a token** to pose the chain. Drag the root to translate the whole thing.
5. Right-click a token → **Remove from IK chain** to trim it, or use a chain card's
   **Delete** button in the sidebar to remove the whole chain.

## Why controls live in the sidebar (not the toolbar)

Owlbear renders its own notifications in the top-center toolbar area, so stacking
extra tool-mode buttons there fights that messaging. Posing genuinely needs a
canvas tool (the SDK only routes drag events to a tool), so there is exactly
**one** IK Chains tool with **one** mode — no secondary mode-button row — and
everything else (building, settings, deletion) lives in the action **popover** and
the **right-click** menu.

## Architecture

Two entry points, coordinated purely through Owlbear scene metadata:

- **`background.html` → `src/background.ts`** — the always-loaded page. On
  `OBR.onReady` it registers the tool + context menu and prunes chains whose
  tokens were deleted (GM single-writer).
- **`index.html` → `src/ui/SidebarApp.tsx`** — the React action popover.

```
src/
├─ types.ts          # Chain / ChainNode / ChainSettings, metadata key
├─ ik/               # PURE solver — no Owlbear imports, unit-tested
│  ├─ vec.ts         #   2D vector math
│  ├─ fabrik.ts      #   single-chain FABRIK
│  └─ pose.ts        #   solve root→grabbed + rigid tail carry; rigidTranslate; boneAngles
├─ model/
│  └─ chains.ts      #   PURE chain-model ops (create / build / remove / prune / settings)
├─ obr/              # Owlbear wiring (the only place that talks to the SDK)
│  ├─ constants.ts   #   ids, asset() base-path helper, token layers
│  ├─ scene.ts       #   item helpers, rad→deg, selection (token-layer filtered)
│  ├─ chainStore.ts  #   scene-metadata persistence (+ re-exports the model)
│  ├─ tool.ts        #   the single Pose tool (interaction-API streaming)
│  └─ contextMenu.ts #   "Remove from IK chain"
├─ background.ts     # registers everything on OBR.onReady
└─ ui/               # SidebarApp.tsx + theme.ts + icons.tsx + styles.css
```

The **pure** layers (`ik/`, `model/`) take and return plain data and are covered by
unit tests; only `obr/` imports the SDK.

### Data model

Chains live in scene metadata under `rodeo.wilder.ik/chains` as `chainId → Chain`:

```ts
Chain {
  id: string
  rootId: string                         // token id of the pinned root
  nodes: Record<tokenId, {
    parentId: string | null              // null only for the root
    restLength: number                   // fixed length to parent (0 for root)
    boneOffsetDeg?: number               // authored rotation relative to the bone
  }>
  settings: { autoRotate: boolean }
}
```

A chain is a single linear strand: the root, then one node after another. There is
no branching — a creature with several limbs is several chains.

## Development

```bash
npm install
npm run dev        # Vite dev server (served under /IK-Extension/)
```

In Owlbear → **Add Custom Extension**, paste the dev manifest URL:
`http://localhost:5173/IK-Extension/manifest.json`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server. |
| `npm test` | Run the pure unit tests (Vitest). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Typecheck, then build the static site to `dist/`. |
| `npm run preview` | Preview the production build. |

## Testing & verification

- **Unit tests** (`npm test`) cover the pure layers: FABRIK keeps the root pinned
  and rest lengths within tolerance, unreachable targets straighten, a
  zero-length chain doesn't collapse; the tail is carried rigidly and a root drag
  translates every node; and the chain-model ops (build / remove-truncate / prune /
  settings) behave and never mutate their inputs.
- **In-Owlbear check** (can't be done headless — the popover only populates after
  `OBR.onReady`): select 3–4 tokens root-first → **New chain from selection** →
  pick the IK Chains tool → drag a tip (flexes, root pinned) → drag the root
  (translates) → reload (persists) → open a second client (syncs).

## Deployment

Hosted on **GitHub Pages** via GitHub Actions (`.github/workflows/deploy.yml`).
Because a Pages *project* site is served from `/IK-Extension/`, the build sets Vite
`base: "/IK-Extension/"` and the manifest's `icon` / `action.popover` /
`background_url` carry that prefix; in-code icons resolve through the `asset()`
helper. If the repo is renamed or moved to a root domain, update `base` in
`vite.config.ts` and the paths in `public/manifest.json`.

## Design decisions & non-goals

- **Single linear chains only.** No branching or multi-effector solving. Multiple
  limbs = multiple chains.
- **Root pinned during IK.** Dragging the root translates; dragging anything else
  solves. Keeps posing predictable.
- **Rigid bones.** Bone lengths are captured at build and preserved while posing.
- **GM-only, one canvas tool.** Posing needs a tool; everything else stays off the
  toolbar (see above). The tool has a single activation hotkey (`K`) so you don't
  have to hunt the toolbar — Owlbear only routes drag events to a custom tool, so
  the built-in Move tool can't run the solver during a drag.
- **Pose undo** is Owlbear's own token undo; the extension writes token positions
  once, on release, through the interaction API.
