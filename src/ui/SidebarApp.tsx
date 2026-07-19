import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { Chain, ChainMap } from "../types";
import {
  buildChain,
  deleteChain,
  findChainForToken,
  getChains,
  onChainsChange,
  orderedNodes,
  removeToken,
  saveChains,
  setParentNode,
  updateSettings,
} from "../obr/chainStore";
import { getItemNames, getPositions, getRotations, getSelectedTokenIds, getSelection } from "../obr/scene";
import { POSE_SHORTCUT } from "../obr/constants";
import { useObrTheme } from "./theme";
import { AnchorIcon, CaretRightIcon, CloseIcon } from "./icons";

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
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
        ? `Built a sub-chain pivoting at ${names[anchor] ?? "the anchor"} — it flexes on its own and follows when that chain moves.`
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
    <div>
      <div className="app-header"><h1>IK Chains</h1></div>
      <p className="hint">
        Rig tokens into a chain and pose them like a limb. Select tokens
        {" "}<strong>root first, then outward</strong>, then build the chain. Pick the
        {" "}<strong>IK Chains</strong> tool (or press <kbd>{POSE_SHORTCUT}</kbd>) and drag
        any token — the chain flexes with the root pinned. Drag the root to move the
        whole thing. To make a sub-chain (a claw, a pincher) ride along with the main
        one, select a token in the main chain <em>first</em>, then the sub-chain's
        tokens, and build — or use a chain card's <strong>Attach</strong> button.
      </p>

      <button className="primary" onClick={onNewChain} disabled={!ready}>
        New chain from selection
      </button>

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

      {list.map((chain) => (
        <ChainCard
          key={chain.id}
          chain={chain}
          chains={chains}
          names={names}
          selected={selected}
          onPatch={patch}
          onAttach={onAttach}
          onDetach={onDetach}
          onSelectNode={(id) => OBR.player.select([id], true).catch(() => {})}
        />
      ))}
    </div>
  );
}

function ChainCard({
  chain,
  chains,
  names,
  selected,
  onPatch,
  onAttach,
  onDetach,
  onSelectNode,
}: {
  chain: Chain;
  chains: ChainMap;
  names: Record<string, string>;
  selected: ReadonlySet<string>;
  onPatch: (next: ChainMap) => Promise<void>;
  onAttach: (chainId: string, parentTokenId: string) => void;
  onDetach: (chainId: string) => void;
  onSelectNode: (id: string) => void;
}) {
  const nodes = orderedNodes(chain);
  const rootName = names[chain.rootId] ?? chain.rootId.slice(0, 8);

  const onDelete = () => onPatch(deleteChain(chains, chain.id));
  const onRemoveNode = (id: string) => onPatch(removeToken(chains, id));
  const setAutoRotate = (v: boolean) => onPatch(updateSettings(chains, chain.id, { autoRotate: v }));

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
    <div className="chain">
      <div className="chain-header">
        <div>
          <div className="chain-title">{rootName}</div>
          <div className="chain-sub">{nodes.length} token{nodes.length === 1 ? "" : "s"}</div>
        </div>
        <button className="danger" onClick={onDelete}>Delete</button>
      </div>

      <div className="row">
        <label htmlFor={`ar-${chain.id}`}>Auto-rotate tokens</label>
        <input id={`ar-${chain.id}`} type="checkbox"
          checked={chain.settings.autoRotate}
          onChange={(e) => setAutoRotate(e.target.checked)} />
      </div>

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
          return (
            <div className={`node${selected.has(id) ? " selected" : ""}`} key={id}
              style={{ paddingLeft: isRoot ? 8 : 22 }}>
              <button type="button" className="node-main node-select"
                title="Select this token on the map" onClick={() => onSelectNode(id)}>
                {isRoot
                  ? <span className="node-icon root" title="Pinned root"><AnchorIcon size={13} /></span>
                  : <span className="node-icon"><CaretRightIcon size={12} /></span>}
                <span className="node-name">{names[id] ?? id.slice(0, 8)}</span>
                {isRoot && <span className="badge">root</span>}
              </button>
              <div className="node-ctl">
                <button className="mini-btn danger icon-btn"
                  title={isRoot ? "Delete the whole chain" : "Remove this token and the strand past it"}
                  aria-label={isRoot ? "Delete the whole chain" : `Remove ${names[id] ?? "token"}`}
                  onClick={() => onRemoveNode(id)}><CloseIcon size={13} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
