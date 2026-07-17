# IK Chains — Owlbear Rodeo Extension

Rig map tokens into **2D inverse-kinematics chains** and pose them like
articulated limbs. Assign one token as a pinned **root**, link other tokens
outward from it, then drag any token to make the whole chain flex — the root
stays put and acts as the pivot. Great for a monster's long claws, a
segmented tentacle, or a hanging rope.

## Status

**Phase 1 (MVP).** Implemented so far:

- A dedicated **IK Chains** toolbar tool with two modes:
  - **Build** — click a token to set the root, then click tokens outward to
    link them; click an existing node to branch from it.
  - **Pose** — drag any token to solve the chain in real time
    ([FABRIK](https://en.wikipedia.org/wiki/Inverse_kinematics), root pinned,
    rigid bones, optional auto-rotate). Dragging the root translates the whole
    chain; dragging a mid/leaf token flexes the branch and trails the rest.
    Multi-select (box-select a cluster) group-moves rigidly while the chain
    back to the root re-solves.
- **Context menu** entries: *Set as IK Root*, *Remove from IK Chain*.
- A **sidebar** (the toolbar action) listing chains with per-chain settings:
  auto-rotate, connector overlay, "players may pose", recalibrate, delete.
- Chains persist in **scene metadata** (synced to all clients, survive reload)
  and are pruned when a referenced token is deleted.
- **Permissions**: GM-only by default; per-chain "players may pose" and
  per-node overrides (e.g. a rope players can swing but whose anchor stays
  locked) enforced in the tool logic.

Planned next: richer sidebar tree editing, joint-angle limits, and a broader
group-move UX. See the design notes in the PR description.

## Architecture

- `src/ik/` — **pure, unit-tested** solver with no OBR dependencies:
  `fabrik.ts` (FABRIK), `tree.ts` (branch/subtree/selection helpers),
  `pose.ts` (orchestration + rigid sub-tree carry), `vec.ts` (2D math).
- `src/obr/` — Owlbear wiring: `tool.ts` (pose + build modes via the
  interaction API), `contextMenu.ts`, `chainStore.ts` (scene-metadata CRUD),
  `connectors.ts` (overlay), `scene.ts`/`constants.ts` (helpers).
- `src/background.ts` — registers the tool/menus on `OBR.onReady` and keeps
  chains pruned + connectors in sync. Loaded via the manifest's `background_url`.
- `src/ui/` — React sidebar (`SidebarApp.tsx`), the manifest `action` popover.
- `public/manifest.json` — the Owlbear extension manifest.

## Develop

```bash
npm install
npm run dev        # serve on http://localhost:5173
```

In Owlbear Rodeo → **Extensions → Add Custom Extension**, paste the dev
manifest URL: `http://localhost:5173/manifest.json`.

## Verify

```bash
npm test           # pure IK unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build to dist/
```

Then manually in an Owlbear room: build a 3–4 token chain in Build mode, switch
to Pose mode, and confirm the chain flexes smoothly with the root pinned.
Reload the scene to confirm persistence; open a second browser as a player to
confirm sync and permissions.

## Deploy

`npm run build` produces a static `dist/`. Host it (GitHub Pages, Netlify, …)
and share `<host>/manifest.json`. Ensure the manifest's action/background URLs
resolve on the final host.
