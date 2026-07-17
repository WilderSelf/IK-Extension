# IK Chains — Owlbear Rodeo Extension

Rig map tokens into **2D inverse-kinematics chains** and pose them like
articulated limbs. Assign one token as a pinned **root**, link other tokens
outward from it, then drag any token to make the whole chain flex realistically
— the root stays put and acts as the pivot.

Perfect for a monster's long claws, a segmented tentacle, a mechanical arm, or a
hanging rope your players can swing.

<p align="center"><em>root (pinned) → joint → joint → tip &nbsp;&nbsp;·&nbsp;&nbsp; drag the tip, the arm follows</em></p>

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Posing: how movement works](#posing-how-movement-works)
- [Permissions](#permissions)
- [Sidebar reference](#sidebar-reference)
- [Worked examples](#worked-examples)
- [Architecture](#architecture)
- [Development](#development)
- [Testing & verification](#testing--verification)
- [Deployment](#deployment)
- [Design decisions & non-goals](#design-decisions--non-goals)
- [Roadmap](#roadmap)

---

## What it does

- **Dedicated `IK Chains` toolbar tool** with two modes:
  - **Build** — click tokens to assemble a chain (root, then outward; click an
    existing node to branch).
  - **Pose** — drag any token to solve the chain in real time
    ([FABRIK](https://en.wikipedia.org/wiki/FABRIK), root pinned).
- **Branching trees** — one root can sprout several independent limbs (e.g. a
  body with three claws).
- **Group move** — box-select a cluster (a hand and all its fingers) and drag it
  as a rigid group; the chain back to the root re-solves to follow.
- **Rigid bones** — segment lengths are captured when you build the chain and
  preserved while posing, with a one-click **Recalibrate** to re-measure.
- **Bend limits** — optional per-joint angle constraints (e.g. a knee that only
  bends one way), enforced by the solver while bone lengths stay fixed.
- **Auto-rotate** — tokens rotate to face down their bone as the limb flexes
  (per-chain, with a tunable rotation offset for art that doesn't point "up").
- **Permissions** — GM-only by default, with per-chain and per-node overrides so
  players can, say, swing a rope whose anchor stays locked.
- **Skeleton overlay** — optional in-canvas handles: a line along each bone, a
  dot on every joint, and a distinct ring on the root, for building and
  debugging (off by default).
- **Undo / redo** — step backward and forward through rig edits (build, link,
  remove, recalibrate, settings, constraints, preset apply) from the sidebar.
- **Presets** — save a rig's whole shape (topology, bone lengths, constraints,
  settings) as a named preset and re-apply it to another creature's tokens —
  copy-paste a spider leg or tentacle instead of rebuilding it.
- **Persistence & sync** — chains and presets live in the scene's metadata, so
  they survive reloads and sync to every connected client automatically.
  Deleting a token prunes it from its chain.

## Quick start

1. **Install** the extension in Owlbear Rodeo → **Extensions → Add Custom
   Extension**, using your hosted (or local dev) `manifest.json` URL.
2. Select the **IK Chains** tool in the toolbar, then its **Build** mode (the
   chain-link icon).
3. **Click the token** that should be the anchor — this sets the **root** (the pinned anchor).
4. **Click tokens outward** from the root, in order, to link them into a limb.
   To start another limb, click an existing node (to re-anchor there), then keep
   clicking new tokens.
5. Switch to **Pose** mode (the hand icon) and **drag a token**. The chain flexes
   with the root pinned. Drag the root to move the whole thing.
6. Open the extension's **sidebar** (its toolbar action icon) to tweak settings,
   edit the tree, and manage permissions.

> **Tip:** you can also right-click a token and choose **Set as IK Root** or
> **Remove from IK Chain** from the context menu.

## Concepts

| Term | Meaning |
| --- | --- |
| **Root** | The pinned pivot. During IK it never moves; dragging it translates the whole chain rigidly. |
| **Node** | Any token in the chain. Every non-root node has exactly one parent. |
| **Bone** | The connection between a node and its parent. Its **rest length** is fixed (captured at build time). |
| **Branch** | A linear strand from the root outward. Branches that split at the root solve **independently**; two tips forking off a shared unlocked joint are solved **jointly** so they negotiate that joint. |
| **Tip** | A leaf node (no children) — the end of a limb. |
| **Grabbed node** | The node you drag; it becomes the IK target for its branch. Nodes *beyond* it trail rigidly. |

## Posing: how movement works

- **Drag the root** → the entire chain translates rigidly (nothing bends).
- **Drag a tip or mid node** → the path from the root to that node re-solves with
  FABRIK so the node reaches your cursor; the root stays pinned, and any nodes
  *past* the grabbed one trail along rigidly.
- **Box-select then drag** → for each branch, the **shallowest selected node**
  becomes that branch's IK target and deeper selected nodes ride along as a rigid
  cluster. So selecting a hand + its fingers and dragging moves them together
  while the arm re-solves back to the body.
- **Unreachable target** → if you pull past the chain's full length, it simply
  straightens toward the cursor.

All of this streams through Owlbear's **interaction API**, so motion is smooth
locally and sampled to the network for other players — the scene is only written
once, when you release.

## Permissions

By default, **only the GM** can build or pose chains. You can loosen this
per chain and per node from the sidebar:

- **Players may pose** (per chain) — lets non-GM players drag this chain's nodes.
- **player** (per node) — when players-may-pose is on, toggle whether *this*
  specific node is movable by players. The **root/anchor is off-limits to
  players by default**, so a rope's segments can be player-swingable while its
  anchor stays fixed — flip the root's **player** box to allow it.
- **lock** (per node) — pin a node: *nobody* (not even the GM in Pose mode) can
  grab it, and it anchors the chain during solves, so posing a node farther out
  flexes only the segment below the lock and leaves everything above it fixed.

Enforcement lives in the tool logic, so it holds regardless of Owlbear's own
item permissions.

## Sidebar reference

At the top of the panel, **Undo** / **Redo** step through rig edits (build,
link, remove, recalibrate, settings, constraints, preset apply). History is
per-sidebar-session; it isn't shared between clients and resets when the sidebar
is reopened.

Each chain card exposes:

| Control | Effect |
| --- | --- |
| **Auto-rotate tokens** | Rotate each token to face down its bone as it flexes. |
| **Rotation offset (°)** | Added to the computed bone angle. Default `90` (art points "up"); change if a token's forward is a different direction. |
| **Show connector lines** | Draw the skeleton overlay: a line along each bone, a dot on every joint, and a ring on the root (non-interactive). |
| **Players may pose** | Allow non-GM players to pose this chain. |
| **Recalibrate** | Re-measure current token spacing as the new rest lengths (use after rearranging tokens by hand). |
| **Save as preset** | Name the current rig and store its shape as a reusable preset (see below). |
| **Tokens** (tree) | The chain's nodes, indented by depth. Per node: `player` / `lock` toggles, a `bend` limit (where applicable), and a remove button (removing the root deletes the chain; removing an interior node re-parents its children). |
| **Delete** | Remove the whole chain. |

Below the chain cards, a **Presets** panel lists every saved preset with an
**Apply** and a delete (`✕`) button.

### Bend limits (angle constraints)

Each joint can be capped so it only flexes within a range — a knee that bends
one way, an elbow that can't hyperextend. Tick **bend** on a node to reveal
`min°` / `max°`, measured **relative to the parent bone**:

- `0` means "in line with the incoming bone" (straight).
- The two signs are the two bend directions. Which sign is which depends on how
  the tokens are laid out, so tune the numbers by eye and watch the limb.
- A range like `-160 … 0` lets the joint fold one way only; `-45 … 45` keeps it
  roughly straight.

The limit needs a reference bone above it, so it's offered only on nodes whose
parent isn't the root (the first bone off the root, or off a locked sub-base
pin, can point anywhere). Limits are enforced during posing and preserve bone
lengths; an unreachable target settles into the closest pose the limits allow.

### Presets (copy-paste a rig)

A preset stores a chain's *shape* — topology, rest lengths, per-joint bend
limits, per-node locks/permissions, and chain settings — with the token ids
stripped out, so it can be stamped onto a different creature:

1. Build and tune a rig once (say, one spider leg).
2. On its chain card, type a name and click **Save as preset**.
3. On the target creature, **select the tokens** that should become the new
   rig — **root first, then outward in the same order** you'd build them.
4. In the **Presets** panel, click **Apply**. The selection count must match the
   preset's node count; the mapping follows selection order.

Presets are saved in the scene, so everyone in the room shares the library and
they persist across reloads.

## Worked examples

**Monster with two claws**

1. Build mode → click the **body** (root).
2. Click the first claw's segments outward: `body → claw-a-1 → claw-a-2 → claw-a-tip`.
3. Click the **body** again to re-anchor, then build the second claw:
   `body → claw-b-1 → claw-b-2 → claw-b-tip`.
4. Pose mode → drag either claw tip; each claw articulates independently while
   the body stays put.

**Player-swingable rope**

1. Build mode → click the ceiling **anchor** (root), then the rope segments down
   to the free **end**.
2. Sidebar → enable **Players may pose**. Leave the anchor's **player** box off
   (players can swing the rope but can't move where it's tied).
3. Players select Pose mode and drag the rope end to swing it; the anchor holds.

## Architecture

Two entry points, coordinated purely through Owlbear scene metadata:

- **`background.html` → `src/background.ts`** — the always-loaded page (declared
  via the manifest's `background_url`). On `OBR.onReady` it registers the tool
  and context menus, prunes chains that reference deleted tokens, and keeps the
  connector overlay in sync.
- **`index.html` → `src/ui/SidebarApp.tsx`** — the React action popover (the
  sidebar).

### Modules

```
src/
├─ types.ts              # Chain / ChainNode / ChainSettings, metadata keys
├─ model/
│  ├─ chains.ts          # PURE chain-model ops (create/add/remove/prune/…)
│  ├─ templates.ts       # PURE preset ops (chain <-> token-agnostic template)
│  └─ history.ts         # PURE undo/redo zipper (past/present/future)
├─ ik/                   # PURE solver — no Owlbear imports, fully unit-tested
│  ├─ vec.ts             #   2D vector math
│  ├─ fabrik.ts          #   single-chain FABRIK solver (+ bend limits)
│  ├─ multi.ts           #   multi-effector FABRIK over a shared sub-base
│  ├─ tree.ts            #   branch / subtree / ordering / LCA / selection helpers
│  └─ pose.ts            #   orchestration: group targets, solve, rigid carry
├─ obr/                  # Owlbear wiring
│  ├─ constants.ts       #   ids, layers, rotation default
│  ├─ scene.ts           #   item helpers, rad→deg conversion
│  ├─ chainStore.ts      #   scene-metadata persistence (+ re-exports model)
│  ├─ tool.ts            #   IK tool: Pose + Build modes (interaction API)
│  ├─ contextMenu.ts     #   Set as IK Root / Remove from IK Chain
│  └─ connectors.ts      #   connector-line overlay
├─ background.ts         # registers everything on OBR.onReady
└─ ui/
   ├─ SidebarApp.tsx     # React sidebar (tree editor + settings)
   └─ styles.css
```

The **pure** layers (`ik/`, `model/`) contain no Owlbear SDK imports, take and
return plain data, and are covered by unit tests. The `obr/` layer is the only
place that talks to Owlbear.

### Data model

Chains are stored in scene metadata under `rodeo.wilder.ik/chains` as a map of
`chainId → Chain`:

```ts
Chain {
  id: string
  rootId: string                       // token item id of the pinned root
  nodes: Record<tokenId, {
    parentId: string | null            // null only for the root
    restLength: number                 // fixed length to parent (0 for root)
  }>
  settings: {
    autoRotate: boolean
    rotationOffsetDeg: number
    showConnectors: boolean
    playerPosable: boolean
    nodeOverrides?: Record<tokenId, { playerMovable?: boolean; locked?: boolean }>
  }
}
```

The tree is just the `parentId` links; a *branch* is the path from a leaf to the
root.

### Solver

[FABRIK](https://en.wikipedia.org/wiki/FABRIK) (Forward And Backward Reaching
Inverse Kinematics) — a fast, matrix-free iterative solver ideal for 2D. Each
pose:

1. Picks the grabbed target node(s) (one per branch for group moves).
2. Solves the path `root → target` with FABRIK, pinning the root and preserving
   rest lengths.
3. Rigidly carries everything beyond the target (translation + the target's
   incoming-bone rotation): `newPos = newTarget + R(Δθ)·(oldPos − oldTarget)`.
4. If auto-rotate is on, sets each token's rotation from its bone angle.

Dragging the root instead applies a rigid translation to the whole tree.

## Development

```bash
npm install
npm run dev        # Vite dev server on http://localhost:5173
```

In Owlbear Rodeo → **Extensions → Add Custom Extension**, paste the dev manifest
URL: `http://localhost:5173/manifest.json`.

Scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server. |
| `npm test` | Run the pure unit tests (Vitest). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Typecheck, then build the static site to `dist/`. |
| `npm run preview` | Preview the production build. |

## Testing & verification

- **Unit tests** (`npm test`) cover the pure layers: FABRIK keeps the root
  pinned and rest lengths within tolerance, unreachable targets straighten,
  group carry preserves cluster offsets, independent branches don't interfere, a
  shared unlocked sub-base is negotiated symmetrically (multi-effector) while a
  locked one stays fixed, bend limits are clamped, presets round-trip, the
  undo/redo history navigates and forks correctly, and the chain-model ops
  (create/link/remove/prune/recalibrate/overrides) behave and never mutate their
  inputs. Tree traversals are also exercised at scale
  (thousand-node chains stay linear-time, no stack overflow) and against
  deliberately cyclic metadata (traversals terminate instead of hanging).
- **In-Owlbear check:** build a 3–4 token chain in Build mode, switch to Pose,
  and confirm smooth flex with the root pinned. Reload the scene to confirm
  persistence; open a second browser as a player to confirm sync and that
  permissions block player drags on locked/anchor nodes.

## Deployment

`npm run build` produces a static `dist/` (including `manifest.json` and icons).
Host it anywhere static (GitHub Pages, Netlify, Cloudflare Pages, …) and share
`<host>/manifest.json`. Make sure the manifest's `action.popover`,
`background_url`, and `icon` paths resolve on the final host.

## Design decisions & non-goals

- **Root pinned during IK.** Dragging the root translates; dragging anything else
  solves. This keeps posing predictable.
- **Branches that don't share a joint solve independently; forks that do
  negotiate.** Two claws hanging off the root never disturb each other. But when
  you grab two tips that fork off a *shared unlocked joint*, they're solved
  jointly with multi-effector FABRIK — the shared joint settles at the average of
  what each branch wants, instead of one tip winning and dragging the other.
  Lock the shared joint (or any joint above it) and everything above the lock is
  fixed, so it's never contested.
- **Rigid bones; optional joint-angle limits.** Bones keep their captured length
  always. Joints rotate freely by default, but any joint (with a reference bone
  above it) can be given a per-node **bend limit** so it only flexes within a
  range — enforced in the solver's forward pass, one clamp per joint per
  iteration. Limits are opt-in so the default stays predictable.
- **Pose lives in a dedicated tool.** Real-time solving needs a custom tool's
  drag events; the trade-off is selecting the IK tool to pose.
- **"Lock" pins a joint.** A locked node can't be grabbed *and* acts as an anchor
  during solves: posing a node farther out anchors the chain at the deepest
  locked ancestor, so everything above it holds still and only the segment below
  flexes. Lock a rope's anchor and players can swing the rest; lock a shoulder and
  the forearm still poses from a fixed pivot. (Dragging the root itself still
  translates the whole tree — you're moving the anchor.)
- **Build mode is single-writer, last-write-wins.** A build session keeps an
  in-memory copy of the chain map to avoid read-after-write races on OBR's async
  metadata. Concurrent sidebar edits during an active build session may be
  overwritten on the next build click; finish building before editing.
- **Undo covers rig structure, not poses.** History snapshots the chain map
  (topology, bones, constraints, settings), which lives in scene metadata — not
  the per-drag token positions written through the interaction API. It's a
  per-sidebar-session stack (ephemeral, not shared between clients), which keeps
  it simple and race-free; posing is undone with Owlbear's own token undo.

## Roadmap

Ideas for future iterations:

- Angle constraints for the multi-effector (joint) solve (single-chain bend
  limits are already enforced; forks currently negotiate without them).
- Undo/redo for token **poses** (today's history covers rig structure and
  settings, not the per-drag token positions) and cross-client shared history.
- Draggable (not just visual) in-canvas handles.
