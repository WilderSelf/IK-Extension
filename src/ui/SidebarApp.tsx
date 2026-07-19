import { type KeyboardEvent, useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import {
  type Chain,
  type ChainMap,
  type Stiffness,
  CHAIN_PALETTE,
  STIFFNESS_LABELS,
  STIFFNESS_ORDER,
} from "../types";
import {
  buildChain,
  chainHasLimits,
  chainLimits,
  clearLimits,
  deleteChain,
  effectiveStiffness,
  expandLimits,
  findChainForToken,
  getChains,
  onChainsChange,
  orderedNodes,
  removeToken,
  renameChain,
  renameNode,
  saveChains,
  setChainColor,
  enableSegmentRig,
  disableSegmentRig,
  setChainLimits,
  setNodeStiffness,
  setParentNode,
  updateSettings,
} from "../obr/chainStore";
import { clearHighlights, highlightTokens } from "../obr/highlight";
import { BONES_KEY, EDIT_PIVOTS_KEY, refreshBones } from "../obr/bones";
import { relativeBends } from "../ik/pose";
import { getItemNames, getPositions, getRotations, getSelectedTokenIds, getSelection } from "../obr/scene";
import { POSE_SHORTCUT } from "../obr/constants";
import { useObrTheme } from "./theme";
import { AnchorIcon, CaretRightIcon, CloseIcon, PencilIcon } from "./icons";

/** localStorage keys for per-browser UI preferences. */
const ADVANCED_KEY = "ik.advanced";
const HELP_KEY = "ik.help";

/**
 * A 5-point Loose…Stiff slider. Used for a chain's default and for a single
 * token's override; `inherited` dims it to signal the value is coming from the
 * chain default (or ease ramp) rather than a per-token set. `ends` shows the
 * Loose/Stiff endpoint labels (for the roomier chain-default control).
 */
function StiffnessSlider({
  value,
  onChange,
  inherited = false,
  ends = false,
  label,
}: {
  value: Stiffness;
  onChange: (s: Stiffness) => void;
  inherited?: boolean;
  ends?: boolean;
  label: string;
}) {
  const pos = Math.max(0, STIFFNESS_ORDER.indexOf(value));
  return (
    <div className={`stiff${inherited ? " inherited" : ""}`}>
      {ends && <span className="stiff-end">Loose</span>}
      <input type="range" min={0} max={STIFFNESS_ORDER.length - 1} step={1} value={pos}
        aria-label={label} aria-valuetext={STIFFNESS_LABELS[value]}
        title={`${STIFFNESS_LABELS[value]}${inherited ? " (inherited)" : ""}`}
        onChange={(e) => onChange(STIFFNESS_ORDER[Number(e.target.value)])} />
      {ends && <span className="stiff-end">Stiff</span>}
    </div>
  );
}

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  // The chain currently highlighted on the canvas (clicking its name toggles it).
  const [highlightedChainId, setHighlightedChainId] = useState<string | null>(null);
  // "Advanced settings" reveals per-token stiffness (and, later, bend limits).
  // A local UI preference, not scene data, so it persists per browser.
  const [advanced, setAdvanced] = useState(() => {
    try {
      return localStorage.getItem(ADVANCED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleAdvanced = (v: boolean) => {
    setAdvanced(v);
    try {
      localStorage.setItem(ADVANCED_KEY, v ? "1" : "0");
    } catch {
      /* private-mode / storage-disabled embeds: keep the in-memory toggle */
    }
  };
  // "Show bones" draws every chain's skeleton (bones + joints, in its colour) on
  // top of the tokens — an authoring aid for seeing the rig's joints. A local,
  // per-browser view preference (the tool's pose handler reads it too, so the
  // key is shared, not the React state).
  const [showBones, setShowBones] = useState(() => {
    try {
      return localStorage.getItem(BONES_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleBones = (v: boolean) => {
    setShowBones(v);
    try {
      localStorage.setItem(BONES_KEY, v ? "1" : "0");
    } catch {
      /* storage-disabled embeds: keep the in-memory toggle */
    }
    refreshBones().catch(() => {});
  };
  // "Edit pivots" puts the Pose tool into pivot-drag mode (dragging a joint dot
  // moves that bone's pivot instead of posing). A per-browser view mode, like
  // Bones — which it force-enables, since you need to see the joints to grab them.
  const [editPivots, setEditPivots] = useState(() => {
    try {
      return localStorage.getItem(EDIT_PIVOTS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleEditPivots = (v: boolean) => {
    setEditPivots(v);
    try {
      localStorage.setItem(EDIT_PIVOTS_KEY, v ? "1" : "0");
      if (v) localStorage.setItem(BONES_KEY, "1");
    } catch {
      /* storage-disabled embeds: keep the in-memory toggle */
    }
    if (v) setShowBones(true);
    refreshBones().catch(() => {});
    setStatus(
      v
        ? "Edit pivots on: with the IK Chains tool, drag a joint dot on the map to move that bone's pivot. Turn off to pose again."
        : "",
    );
  };
  // The intro help collapses to a single line; it's shown by default and the
  // last open/closed choice persists per browser (only "0" hides it).
  const [helpOpen, setHelpOpen] = useState(() => {
    try {
      return localStorage.getItem(HELP_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleHelp = () => {
    setHelpOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(HELP_KEY, next ? "1" : "0");
      } catch {
        /* storage-disabled embeds: keep the in-memory state */
      }
      return next;
    });
  };
  useObrTheme();

  useEffect(() => {
    let mounted = true;
    let unsubChains = () => {};
    let unsubPlayer = () => {};
    OBR.onReady(() => {
      // The component may have unmounted while onReady was pending.
      if (!mounted) return;
      setReady(true);
      // Mirror the map selection so chain rows highlight when their token is
      // picked, and stay in step as the selection changes.
      getSelection().then((s) => mounted && setSelected(new Set(s))).catch(() => {});
      unsubPlayer = OBR.player.onChange((p) => setSelected(new Set(p.selection ?? [])));
      getChains().then((c) => mounted && setChains(c)).catch(() => {});
      unsubChains = onChainsChange(setChains);
    });
    return () => {
      mounted = false;
      unsubChains();
      unsubPlayer();
    };
  }, []);

  // Grow the popover to fit its content; when Owlbear caps it at the pane
  // height, the body scrolls rather than clipping. (setHeight is clamped by OBR.)
  useEffect(() => {
    if (!ready) return;
    const measure = () => {
      const h = document.documentElement.scrollHeight;
      OBR.action.setHeight(Math.min(Math.max(h, 120), 2000)).catch(() => {});
    };
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    measure();
    return () => ro.disconnect();
  }, [ready]);

  // Refresh token display names whenever the set of chained tokens changes.
  useEffect(() => {
    const ids = Object.values(chains).flatMap((c) => Object.keys(c.nodes));
    if (ids.length === 0) {
      setNames({}); // clear stale names once the last chain is gone
      return;
    }
    let cancelled = false;
    getItemNames(ids).then((n) => !cancelled && setNames(n)).catch(() => {});
    return () => {
      cancelled = true; // ignore an out-of-order resolution from a prior render
    };
  }, [chains]);

  // Clear the on-canvas highlight and forget which chain was lit.
  const dropHighlight = () => {
    clearHighlights().catch(() => {});
    setHighlightedChainId(null);
  };

  // Highlight lifecycle: clear any stale highlight shapes on open and on close so
  // they never outlive the popover.
  useEffect(() => {
    if (!ready) return;
    clearHighlights().catch(() => {});
    return () => {
      clearHighlights().catch(() => {});
    };
  }, [ready]);

  // If the highlighted chain is deleted, drop its highlight.
  useEffect(() => {
    if (highlightedChainId && !chains[highlightedChainId]) dropHighlight();
  }, [chains, highlightedChainId]);

  // Keep the skeleton overlay in step with the chain set (build/delete/attach/
  // rename-colour all flow through `chains`). refreshBones clears-then-rebuilds,
  // and is a no-op clear while the toggle is off, so it's safe to run every time
  // — it also sweeps any stale shapes on open. The overlay is a persistent view
  // mode, so it deliberately survives the popover closing (poses redraw it from
  // the tool's drag-end handler; turning the toggle off clears it).
  useEffect(() => {
    if (!ready) return;
    refreshBones().catch(() => {});
  }, [ready, chains]);

  // Never leave the tool stuck in pivot-edit mode with nothing to edit: if the
  // last segment rig is turned off, exit edit-pivots so dragging poses again.
  useEffect(() => {
    const hasSeg = Object.values(chains).some((c) => c.settings.segmentRig);
    if (hasSeg || !editPivots) return;
    setEditPivots(false);
    try {
      localStorage.setItem(EDIT_PIVOTS_KEY, "0");
    } catch {
      /* ignore */
    }
    refreshBones().catch(() => {});
  }, [chains, editPivots]);

  // Toggle the on-canvas highlight for a chain. Clicking the already-highlighted
  // chain clears it. We deliberately DON'T OBR.player.select() the tokens here:
  // Owlbear paints its own accent-coloured selection outline over a selection,
  // which sat on top of the chain-colour aura and read as the "highlight" instead
  // of the swatch colour. Posing doesn't need a selection (the Pose tool resolves
  // the grabbed token by drag-target/proximity), so the aura is now the only
  // highlight — and it's in the chain's colour.
  const onSelectChain = (chainId: string, ids: string[], color: string) => {
    if (highlightedChainId === chainId) {
      dropHighlight();
      return;
    }
    highlightTokens(ids, color).catch(() => {});
    setHighlightedChainId(chainId);
  };

  // Recolour a chain; if it's the one currently highlighted, refresh the aura
  // live so the canvas keeps up with the swatch.
  const onSetChainColor = (chainId: string, color: string) => {
    patch(setChainColor(chains, chainId, color));
    if (highlightedChainId === chainId) {
      const chain = chains[chainId];
      if (chain) highlightTokens(orderedNodes(chain), color).catch(() => {});
    }
  };

  async function patch(next: ChainMap) {
    setChains(next);
    await saveChains(next);
  }

  // Toggle limb mode. Turning it ON captures each token's rigid-segment data from
  // the CURRENT pose (so pose the chain to a neutral rest first), which needs the
  // live positions + rotations; turning it off just clears the flag.
  const onToggleSegmentRig = async (chainId: string, on: boolean) => {
    if (!on) {
      await patch(disableSegmentRig(chains, chainId));
      return;
    }
    const chain = chains[chainId];
    if (!chain) return;
    const ids = orderedNodes(chain);
    const [positions, rotations] = await Promise.all([getPositions(ids), getRotations(ids)]);
    const next = enableSegmentRig(chains, chainId, positions, rotations);
    if (next === chains) {
      setStatus("Couldn't enable limb mode — need at least two tokens with known positions.");
      return;
    }
    await patch(next);
    setStatus("Limb mode on: segments now pivot at their joints. Re-toggle after re-posing to recapture the rest pose.");
  };

  async function onNewChain() {
    const ids = await getSelectedTokenIds();
    if (ids.length < 2) {
      setStatus("Select the tokens for the chain — root first, then outward — then click New chain from selection.");
      return;
    }
    // If the first selected token is already in a chain, treat it as an ANCHOR:
    // it becomes the sub-chain's ROOT (a pivot shared with its chain), so the new
    // tokens articulate off it, and the sub-chain rides along when the anchor's
    // chain moves.
    const anchor = findChainForToken(chains, ids[0]) ? ids[0] : null;
    const rest = (anchor ? ids.slice(1) : ids).filter((id) => !findChainForToken(chains, id));
    const buildIds = anchor ? [anchor, ...rest] : rest;
    if (buildIds.length < 2) {
      setStatus(
        anchor
          ? "Select the anchor token (already in a chain) first, then at least one new token for the sub-chain."
          : "Select at least two unchained tokens — root first, then outward.",
      );
      return;
    }
    const [positions, rotations] = await Promise.all([getPositions(buildIds), getRotations(buildIds)]);
    const built = buildChain(chains, buildIds, positions, rotations);
    if (!built) {
      setStatus("Couldn't build a chain from that selection.");
      return;
    }
    const next = anchor ? setParentNode(built[0], built[1], anchor) : built[0];
    await patch(next);
    setStatus(
      anchor
        ? `Built a sub-chain joined at ${names[anchor] ?? "the anchor"}. Pose it on its own, and it moves with ${names[anchor] ?? "the anchor"}'s chain.`
        : `Built a ${buildIds.length}-token chain. Pick the IK Chains tool (or press ${POSE_SHORTCUT}) and drag a token to pose it.`,
    );
  }

  async function onAttach(chainId: string, parentTokenId: string) {
    const next = setParentNode(chains, chainId, parentTokenId);
    if (next === chains) {
      setStatus("Can't attach there — select a single token that's in another chain (and not one that already follows this one).");
      return;
    }
    await patch(next);
    setStatus(`This chain now follows ${names[parentTokenId] ?? "that token"} — it rides along when that chain moves.`);
  }

  const onDetach = (chainId: string) => patch(setParentNode(chains, chainId, null));

  const list = Object.values(chains);
  const hasSegmentRig = list.some((c) => c.settings.segmentRig);

  return (
    <div className="app">
      {/* Sticky top: title, Advanced toggle, and the build button stay put while
          the chain list scrolls under them. */}
      <div className="app-top">
        <div className="app-header">
          <h1>IK Chains</h1>
          <div className="top-toggles">
            <label className="adv-toggle"
              title="Draw every chain's skeleton (bones + joints, in its colour) on top of the tokens">
              <input type="checkbox" checked={showBones}
                onChange={(e) => toggleBones(e.target.checked)} />
              Bones
            </label>
            {hasSegmentRig && (
              <label className="adv-toggle"
                title="Drag a joint dot on the map to move that bone's pivot (uses the IK Chains tool). Shows the skeleton and pauses posing while on.">
                <input type="checkbox" checked={editPivots}
                  onChange={(e) => toggleEditPivots(e.target.checked)} />
                Edit pivots
              </label>
            )}
            <label className="adv-toggle"
              title="Reveal extra per-token controls: stiffness weights and bend limits">
              <input type="checkbox" checked={advanced}
                onChange={(e) => toggleAdvanced(e.target.checked)} />
              Advanced
            </label>
          </div>
        </div>

        <button className="primary" onClick={onNewChain} disabled={!ready}
          title="Build a chain from the selected tokens — select the root first, then each token outward">
          New chain from selection
        </button>
      </div>

      <div className="help">
        <button type="button" className="help-toggle" aria-expanded={helpOpen}
          onClick={toggleHelp} title={helpOpen ? "Hide the how-it-works help" : "Show the how-it-works help"}>
          <CaretRightIcon size={12} className={`help-caret${helpOpen ? " open" : ""}`} />
          How it works
        </button>
        {helpOpen && (
          <p className="hint" id="help-body">
            Rig tokens into a chain and pose them like a limb. Select tokens
            {" "}<strong>root first, then outward</strong>, then build the chain. Pick the
            {" "}<strong>IK Chains</strong> tool (or press <kbd>{POSE_SHORTCUT}</kbd>) and drag
            any token — the chain flexes with the root pinned. Drag the root to move the
            whole thing. To make a sub-chain (a claw, a pincher) ride along with the main
            one, select a token in the main chain <em>first</em>, then the sub-chain's
            tokens, and build — or use a chain card's <strong>Attach</strong> button.
          </p>
        )}
      </div>

      {!ready && <p className="empty">Connecting to Owlbear Rodeo…</p>}
      {ready && list.length === 0 && <p className="empty">No chains yet.</p>}

      {status && (
        <div className="notice" role="status" aria-live="polite">
          <span>{status}</span>
          <button className="notice-dismiss" aria-label="Dismiss message"
            title="Dismiss" onClick={() => setStatus("")}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      <div className="chain-list">
        {list.map((chain) => (
          <ChainCard
            key={chain.id}
            chain={chain}
            chains={chains}
            names={names}
            selected={selected}
            advanced={advanced}
            onPatch={patch}
            onAttach={onAttach}
            onDetach={onDetach}
            onToggleSegmentRig={onToggleSegmentRig}
            onSelectNode={(id) => OBR.player.select([id], true).catch(() => {})}
            onSelectChain={onSelectChain}
            onSetColor={onSetChainColor}
            highlighted={highlightedChainId === chain.id}
          />
        ))}
      </div>
    </div>
  );
}

function ChainCard({
  chain,
  chains,
  names,
  selected,
  advanced,
  onPatch,
  onAttach,
  onDetach,
  onToggleSegmentRig,
  onSelectNode,
  onSelectChain,
  onSetColor,
  highlighted,
}: {
  chain: Chain;
  chains: ChainMap;
  names: Record<string, string>;
  selected: ReadonlySet<string>;
  advanced: boolean;
  onPatch: (next: ChainMap) => Promise<void>;
  onAttach: (chainId: string, parentTokenId: string) => void;
  onDetach: (chainId: string) => void;
  onToggleSegmentRig: (chainId: string, on: boolean) => void;
  onSelectNode: (id: string) => void;
  onSelectChain: (chainId: string, ids: string[], color: string) => void;
  onSetColor: (chainId: string, color: string) => void;
  highlighted: boolean;
}) {
  const nodes = orderedNodes(chain);
  const rootName = names[chain.rootId] ?? chain.rootId.slice(0, 8);
  // Display labels: the custom name if set, else the token's scene name.
  const chainLabel = chain.name?.trim() || rootName;
  const nodeLabel = (id: string) => chain.nodes[id]?.name?.trim() || names[id] || id.slice(0, 8);
  // Highlight colour (neutral fallback for chains built before colours existed).
  const chainColor = chain.color ?? "#8b8f9a";
  const [showColors, setShowColors] = useState(false);
  const pickColor = (c: string) => {
    onSetColor(chain.id, c);
    setShowColors(false);
  };

  // Collapse the whole card to just its name; collapse each token to just its
  // name (hiding its stiffness sub-row). Tokens start collapsed so the list
  // stays compact — expand a token to tweak its stiffness.
  const [collapsed, setCollapsed] = useState(false);
  const [openTokens, setOpenTokens] = useState<ReadonlySet<string>>(() => new Set());
  const toggleToken = (id: string) =>
    setOpenTokens((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Inline rename for the chain name or a single token's name.
  const [editing, setEditing] = useState<null | { type: "chain" } | { type: "node"; id: string }>(null);
  const [draft, setDraft] = useState("");
  const startEditChain = () => { setEditing({ type: "chain" }); setDraft(chain.name ?? rootName); };
  const startEditNode = (id: string) => { setEditing({ type: "node", id }); setDraft(chain.nodes[id]?.name ?? names[id] ?? ""); };
  const commitEdit = () => {
    if (!editing) return;
    onPatch(editing.type === "chain"
      ? renameChain(chains, chain.id, draft)
      : renameNode(chains, editing.id, draft));
    setEditing(null);
  };
  const cancelEdit = () => setEditing(null);
  const renameKeys = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitEdit();
    else if (e.key === "Escape") cancelEdit();
  };

  const onDelete = () => onPatch(deleteChain(chains, chain.id));
  const onRemoveNode = (id: string) => onPatch(removeToken(chains, id));
  const setAutoRotate = (v: boolean) => onPatch(updateSettings(chains, chain.id, { autoRotate: v }));
  const chainDefault = chain.settings.defaultStiffness ?? "normal";
  const ease = !!chain.settings.ease;
  const setDefaultStiffness = (s: Stiffness) =>
    onPatch(updateSettings(chains, chain.id, { defaultStiffness: s }));
  const setEase = (v: boolean) => onPatch(updateSettings(chains, chain.id, { ease: v }));
  const setNodeStiff = (id: string, s: Stiffness) => onPatch(setNodeStiffness(chains, id, s));
  const clearNodeStiff = (id: string) => onPatch(setNodeStiffness(chains, id, null));

  // Bend limits, captured by posing. A chain needs at least one joint with a
  // reference bone above it (the 3rd token onward) to have anything to limit.
  const limited = chainHasLimits(chain);
  const canLimit = nodes.length >= 3;
  // The first extreme is held here until the second capture unions them into a
  // real range; a lone pose is never persisted (it would freeze the joint).
  const [pendingEdge, setPendingEdge] = useState<Record<string, number> | null>(null);
  const [capturing, setCapturing] = useState(false);
  const onCapture = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const positions = await getPositions(nodes);
      const bends = relativeBends(chain, positions);
      if (Object.keys(bends).length === 0) return;
      if (!limited && !pendingEdge) {
        setPendingEdge(bends); // first extreme — nothing persisted yet
        return;
      }
      const ranges = pendingEdge
        ? expandLimits(expandLimits({}, pendingEdge), bends) // union the two extremes
        : expandLimits(chainLimits(chain), bends); // widen the live range
      setPendingEdge(null);
      await onPatch(setChainLimits(chains, chain.id, ranges));
    } finally {
      setCapturing(false);
    }
  };
  const onClearLimits = () => {
    setPendingEdge(null);
    onPatch(clearLimits(chains, chain.id));
  };
  const captureLabel = limited ? "Capture (widen)" : pendingEdge ? "Capture pose 2" : "Capture pose 1";
  const captureHint = limited
    ? "Pose past the current range and capture to widen it."
    : pendingEdge
      ? "Now pose the other extreme and capture to lock the range between them."
      : "Pose the chain to one extreme, then capture.";

  // Attachment: a single selected token in ANOTHER chain can become this chain's
  // parent node, so this chain rides along when that one moves.
  const parentName = chain.parentNodeId
    ? names[chain.parentNodeId] ?? chain.parentNodeId.slice(0, 8)
    : undefined;
  const sel = [...selected];
  const attachTarget = sel.length === 1 ? sel[0] : undefined;
  const targetOwner = attachTarget ? findChainForToken(chains, attachTarget) : undefined;
  const canAttach = !!targetOwner && targetOwner.id !== chain.id;

  return (
    <div className={`chain${collapsed ? " collapsed" : ""}`}>
      <div className="chain-header">
        <button className="caret-btn" aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand chain" : "Collapse chain"}
          title={collapsed ? "Expand this chain" : "Collapse this chain to just its name"}
          onClick={() => setCollapsed((c) => !c)}>
          <CaretRightIcon size={12} className={`caret${collapsed ? "" : " open"}`} />
        </button>
        <button className="swatch" style={{ background: chainColor }}
          aria-label="Change chain highlight colour" aria-expanded={showColors}
          title="Change this chain's highlight colour"
          onClick={() => setShowColors((v) => !v)} />
        <div className="chain-heading">
          {editing?.type === "chain" ? (
            <input className="rename-input" autoFocus value={draft} aria-label="Chain name"
              title="Type a name for this chain, then press Enter (Esc to cancel)"
              onChange={(e) => setDraft(e.target.value)} onBlur={commitEdit} onKeyDown={renameKeys} />
          ) : (
            <button className={`chain-title-btn${highlighted ? " highlighted" : ""}`}
              onClick={() => onSelectChain(chain.id, nodes, chainColor)}
              title={highlighted
                ? "Clear this chain's highlight"
                : "Highlight this chain's tokens on the map in its colour"}>
              <span className="chain-title">{chainLabel}</span>
            </button>
          )}
          {!collapsed && (
            <div className="chain-sub">{nodes.length} token{nodes.length === 1 ? "" : "s"}</div>
          )}
        </div>
        <div className="header-ctl">
          {editing?.type !== "chain" && (
            <button className="mini-btn icon-btn" onClick={startEditChain}
              title="Rename this chain" aria-label="Rename chain"><PencilIcon size={13} /></button>
          )}
          {!collapsed && (
            <button className="mini-btn danger" onClick={onDelete}
              title="Delete this whole chain">Delete</button>
          )}
        </div>
      </div>

      {showColors && (
        <div className="palette" role="group" aria-label="Chain highlight colour">
          {CHAIN_PALETTE.map((c) => (
            <button key={c} className={`swatch${c === chainColor ? " active" : ""}`}
              style={{ background: c }} title={c} aria-label={`Set colour ${c}`}
              onClick={() => pickColor(c)} />
          ))}
          <label className="swatch custom" title="Custom colour">
            <input type="color" value={chainColor}
              aria-label="Custom chain colour"
              onChange={(e) => onSetColor(chain.id, e.target.value)} />
          </label>
        </div>
      )}

      {!collapsed && (
       <>
      <div className="row">
        <label htmlFor={`ar-${chain.id}`}
          title="Turn each token to follow its bone as the chain flexes, so its art keeps facing the right way">
          Auto-rotate tokens
        </label>
        <input id={`ar-${chain.id}`} type="checkbox"
          checked={chain.settings.autoRotate}
          onChange={(e) => setAutoRotate(e.target.checked)} />
      </div>

      {advanced && nodes.length >= 2 && (
        <div className="row">
          <label htmlFor={`seg-${chain.id}`}
            title="Limb mode: treat tokens as rigid segments so each pivots at its joint (shoulder/elbow/wrist), not its centre. Pose the chain to a neutral rest first — turning this on captures that pose. Leave off for ropes/tails.">
            Rigid segments (limb)
          </label>
          <input id={`seg-${chain.id}`} type="checkbox"
            checked={!!chain.settings.segmentRig}
            onChange={(e) => onToggleSegmentRig(chain.id, e.target.checked)} />
        </div>
      )}

      {advanced && (
        <div className="stiff-block">
          <div className="row">
            <label htmlFor={`ease-${chain.id}`}
              title="Ramp stiffness along the chain — stiff at the base, easing to loose at the tip. Overrides the default; a per-token setting still wins.">
              Ease (stiff base → loose tip)
            </label>
            <input id={`ease-${chain.id}`} type="checkbox" checked={ease}
              onChange={(e) => setEase(e.target.checked)} />
          </div>
          {!ease && (
            <div className="row">
              <label title="Baseline resistance for every token you haven't set individually below">
                Stiffness (default)
              </label>
              <StiffnessSlider ends value={chainDefault} onChange={setDefaultStiffness}
                label="Default stiffness for this chain" />
            </div>
          )}
        </div>
      )}

      {advanced && canLimit && (
        <div className="limits">
          <div className="row">
            <label title="Lock each joint to the range you pose it through — no angles, just capture two extremes">
              Bend limits
            </label>
            <span className="chain-sub">
              {limited ? "On" : pendingEdge ? "1 pose set" : "Off"}
            </span>
          </div>
          <div className="limits-actions">
            <button className="mini-btn" disabled={capturing} onClick={onCapture}>
              {captureLabel}
            </button>
            {pendingEdge && (
              <button className="mini-btn" onClick={() => setPendingEdge(null)}>Cancel</button>
            )}
            {limited && (
              <button className="mini-btn danger" onClick={onClearLimits}>Clear</button>
            )}
          </div>
          <p className="limits-hint">{captureHint}</p>
        </div>
      )}

      {parentName ? (
        <div className="row">
          <span className="chain-sub" title="This chain follows that token and rides along when it moves">
            ↳ Follows {parentName}
          </span>
          <button className="mini-btn icon-btn" title="Detach — stop following"
            aria-label="Detach from parent" onClick={() => onDetach(chain.id)}>
            <CloseIcon size={13} /> Detach
          </button>
        </div>
      ) : (
        <div className="row">
          <span className="chain-sub">Follow another chain's token</span>
          <button disabled={!canAttach}
            title="Select one token that belongs to another chain, then attach — this chain will ride along with it"
            onClick={() => attachTarget && onAttach(chain.id, attachTarget)}>
            Attach to selection
          </button>
        </div>
      )}

      <div className="nodes">
        <div className="nodes-title">Tokens</div>
        {nodes.map((id) => {
          const isRoot = id === chain.rootId;
          const overridden = chain.nodes[id]?.stiffness !== undefined;
          const hasDetail = advanced && !isRoot; // the stiffness sub-row
          const open = openTokens.has(id);
          const editingThis = editing?.type === "node" && editing.id === id;
          return (
            <div className={`node${selected.has(id) ? " selected" : ""}`} key={id}
              style={{ paddingLeft: isRoot ? 8 : 22 }}>
              <div className="node-row">
                {isRoot ? (
                  <span className="node-icon root" title="Pinned root"><AnchorIcon size={13} /></span>
                ) : hasDetail ? (
                  <button className="caret-btn" aria-expanded={open}
                    aria-label={open ? "Hide stiffness" : "Show stiffness"}
                    title={open ? "Hide this token's stiffness" : "Show this token's stiffness"}
                    onClick={() => toggleToken(id)}>
                    <CaretRightIcon size={12} className={`caret${open ? " open" : ""}`} />
                  </button>
                ) : (
                  <span className="node-icon"><CaretRightIcon size={12} /></span>
                )}
                {editingThis ? (
                  <input className="rename-input" autoFocus value={draft} aria-label="Token name"
                    title="Type a name for this token, then press Enter (Esc to cancel)"
                    onChange={(e) => setDraft(e.target.value)} onBlur={commitEdit} onKeyDown={renameKeys} />
                ) : (
                  <button type="button" className="node-main node-select"
                    title="Select this token on the map" onClick={() => onSelectNode(id)}>
                    <span className="node-name">{nodeLabel(id)}</span>
                    {isRoot && <span className="badge">root</span>}
                  </button>
                )}
                <div className="node-ctl">
                  {!editingThis && (
                    <button className="mini-btn icon-btn" onClick={() => startEditNode(id)}
                      title="Rename this token's display name"
                      aria-label={`Rename ${nodeLabel(id)}`}><PencilIcon size={13} /></button>
                  )}
                  <button className="mini-btn danger icon-btn"
                    title={isRoot ? "Delete the whole chain" : "Remove this token and the strand past it"}
                    aria-label={isRoot ? "Delete the whole chain" : `Remove ${nodeLabel(id)}`}
                    onClick={() => onRemoveNode(id)}><CloseIcon size={13} /></button>
                </div>
              </div>
              {hasDetail && open && (
                <div className="node-stiffness">
                  <span className="node-stiffness-label"
                    title="How much this token's bone resists bending, relative to the rest of the chain">
                    Stiffness
                  </span>
                  <StiffnessSlider inherited={!overridden}
                    value={effectiveStiffness(chain, id)}
                    onChange={(s) => setNodeStiff(id, s)}
                    label={`Stiffness for ${nodeLabel(id)}`} />
                  {overridden && (
                    <button className="mini-btn" onClick={() => clearNodeStiff(id)}
                      title={ease ? "Clear this override — follow the ease ramp" : "Clear this override — follow the chain default"}>
                      Inherit
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
       </>
      )}
    </div>
  );
}
