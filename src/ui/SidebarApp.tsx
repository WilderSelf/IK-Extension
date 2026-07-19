import { type KeyboardEvent, useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { Chain, ChainMap, Stiffness } from "../types";
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
  setChainLimits,
  setNodeStiffness,
  setParentNode,
  updateSettings,
} from "../obr/chainStore";
import { relativeBends } from "../ik/pose";
import { getItemNames, getPositions, getRotations, getSelectedTokenIds, getSelection } from "../obr/scene";
import { POSE_SHORTCUT } from "../obr/constants";
import { useObrTheme } from "./theme";
import { AnchorIcon, CaretRightIcon, CloseIcon, PencilIcon } from "./icons";

/** localStorage keys for per-browser UI preferences. */
const ADVANCED_KEY = "ik.advanced";
const HELP_KEY = "ik.help";

const STIFFNESS_OPTIONS: { value: Stiffness; label: string }[] = [
  { value: "loose", label: "Loose" },
  { value: "normal", label: "Normal" },
  { value: "stiff", label: "Stiff" },
];

/**
 * A three-way Loose/Normal/Stiff picker. Used for a chain's default and for a
 * single token's override; when `inherited` the active segment reads dimmer to
 * signal the value is coming from the chain default rather than a per-token set.
 */
function StiffnessControl({
  value,
  onSelect,
  inherited = false,
  mini = false,
  label,
}: {
  value: Stiffness;
  onSelect: (s: Stiffness) => void;
  inherited?: boolean;
  mini?: boolean;
  label: string;
}) {
  return (
    <div className={`seg${mini ? " mini" : ""}${inherited ? " inherited" : ""}`}
      role="group" aria-label={label}>
      {STIFFNESS_OPTIONS.map((o) => (
        <button key={o.value} type="button"
          className={o.value === value ? "active" : ""}
          aria-pressed={o.value === value}
          title={inherited && o.value === value
            ? `${o.label} (inherited from chain default)`
            : o.label}
          onClick={() => onSelect(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
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

  async function patch(next: ChainMap) {
    setChains(next);
    await saveChains(next);
  }

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

  return (
    <div className="app">
      {/* Sticky top: title, Advanced toggle, and the build button stay put while
          the chain list scrolls under them. */}
      <div className="app-top">
        <div className="app-header">
          <h1>IK Chains</h1>
          <label className="adv-toggle"
            title="Reveal extra per-token controls: stiffness weights and bend limits">
            <input type="checkbox" checked={advanced}
              onChange={(e) => toggleAdvanced(e.target.checked)} />
            Advanced
          </label>
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
            onSelectNode={(id) => OBR.player.select([id], true).catch(() => {})}
            onSelectChain={(ids) => OBR.player.select(ids, true).catch(() => {})}
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
  onSelectNode,
  onSelectChain,
}: {
  chain: Chain;
  chains: ChainMap;
  names: Record<string, string>;
  selected: ReadonlySet<string>;
  advanced: boolean;
  onPatch: (next: ChainMap) => Promise<void>;
  onAttach: (chainId: string, parentTokenId: string) => void;
  onDetach: (chainId: string) => void;
  onSelectNode: (id: string) => void;
  onSelectChain: (ids: string[]) => void;
}) {
  const nodes = orderedNodes(chain);
  const rootName = names[chain.rootId] ?? chain.rootId.slice(0, 8);
  // Display labels: the custom name if set, else the token's scene name.
  const chainLabel = chain.name?.trim() || rootName;
  const nodeLabel = (id: string) => chain.nodes[id]?.name?.trim() || names[id] || id.slice(0, 8);

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
  const setDefaultStiffness = (s: Stiffness) =>
    onPatch(updateSettings(chains, chain.id, { defaultStiffness: s }));
  // Clicking a node's active override clears it (back to the chain default);
  // any other segment sets that override.
  const setNodeStiff = (id: string, s: Stiffness) => {
    const overridden = chain.nodes[id]?.stiffness !== undefined;
    const next = overridden && chain.nodes[id]?.stiffness === s ? null : s;
    onPatch(setNodeStiffness(chains, id, next));
  };

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
        <div className="chain-heading">
          {editing?.type === "chain" ? (
            <input className="rename-input" autoFocus value={draft} aria-label="Chain name"
              title="Type a name for this chain, then press Enter (Esc to cancel)"
              onChange={(e) => setDraft(e.target.value)} onBlur={commitEdit} onKeyDown={renameKeys} />
          ) : (
            <button className="chain-title-btn" onClick={() => onSelectChain(nodes)}
              title="Select all of this chain's tokens on the map">
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

      {advanced && (
        <div className="row">
          <label title="How much each token resists bending — applies to tokens you haven't set individually below">
            Stiffness (default)
          </label>
          <StiffnessControl value={chainDefault} onSelect={setDefaultStiffness}
            label="Default stiffness for this chain" />
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
                  <StiffnessControl mini inherited={!overridden}
                    value={effectiveStiffness(chain, id)}
                    onSelect={(s) => setNodeStiff(id, s)}
                    label={`Stiffness for ${nodeLabel(id)}`} />
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
