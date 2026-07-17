import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { Chain, ChainMap, JointConstraint } from "../types";
import { DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import {
  deleteChain,
  getChains,
  onChainsChange,
  recalibrate,
  removeToken,
  saveChains,
  setNodeConstraint,
  setNodeOverride,
  updateSettings,
} from "../obr/chainStore";
import { getItemNames, getPositions } from "../obr/scene";
import { orderedNodes } from "../ik/tree";

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unsub = () => {};
    OBR.onReady(() => {
      // The component may have unmounted while onReady was pending; don't set
      // state on a dead component and make sure the subscription is cleaned up.
      if (!mounted) return;
      setReady(true);
      getChains().then((c) => mounted && setChains(c)).catch(() => {});
      unsub = onChainsChange(setChains);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // Refresh token display names whenever the set of chained tokens changes.
  useEffect(() => {
    const ids = Object.values(chains).flatMap((c) => Object.keys(c.nodes));
    if (ids.length === 0) {
      setNames({}); // clear stale names once the last chain is gone
      return;
    }
    let cancelled = false;
    getItemNames(ids)
      .then((n) => !cancelled && setNames(n))
      .catch(() => {});
    return () => {
      cancelled = true; // ignore an out-of-order resolution from a prior render
    };
  }, [chains]);

  async function patch(next: ChainMap) {
    setChains(next);
    await saveChains(next);
  }

  const list = Object.values(chains);

  return (
    <div>
      <h1>IK Chains</h1>
      <p className="hint">
        Build articulated token chains and pose them like limbs.
        <ol>
          <li>Open the <strong>IK Chains</strong> tool, then its <strong>Build</strong> mode.</li>
          <li>Click a token to set the <strong>root</strong>, then click tokens outward to link them.</li>
          <li>Click an existing node to branch from it.</li>
          <li>Switch to <strong>Pose</strong> mode and drag any token — the chain flexes, root pinned.</li>
        </ol>
      </p>

      {!ready && <p className="empty">Connecting to Owlbear Rodeo…</p>}
      {ready && list.length === 0 && <p className="empty">No chains yet.</p>}

      {list.map((chain) => (
        <ChainCard
          key={chain.id}
          chain={chain}
          names={names}
          onPatch={patch}
          chains={chains}
        />
      ))}
    </div>
  );
}

function ChainCard({
  chain,
  chains,
  names,
  onPatch,
}: {
  chain: Chain;
  chains: ChainMap;
  names: Record<string, string>;
  onPatch: (next: ChainMap) => Promise<void>;
}) {
  const nodes = orderedNodes(chain);
  const offset = chain.settings.rotationOffsetDeg ?? DEFAULT_ROTATION_OFFSET_DEG;

  const toggle = (key: "autoRotate" | "showConnectors" | "playerPosable", value: boolean) =>
    onPatch(updateSettings(chains, chain.id, { [key]: value }));

  const onOffset = (value: number) =>
    onPatch(updateSettings(chains, chain.id, { rotationOffsetDeg: value }));

  const onDelete = () => onPatch(deleteChain(chains, chain.id));

  const onRemoveNode = (tokenId: string) => onPatch(removeToken(chains, tokenId));

  const onNodeOverride = (
    tokenId: string,
    p: { playerMovable?: boolean; locked?: boolean },
  ) => onPatch(setNodeOverride(chains, chain.id, tokenId, p));

  const onNodeConstraint = (tokenId: string, c: JointConstraint | null) =>
    onPatch(setNodeConstraint(chains, chain.id, tokenId, c));

  async function onRecalibrate() {
    const ids = Object.keys(chain.nodes);
    const positions = await getPositions(ids);
    await onPatch(recalibrate(chains, chain.id, positions));
  }

  return (
    <div className="chain">
      <div className="chain-header">
        <div>
          <div className="chain-title">Chain {chain.id.replace(/^chain_/, "")}</div>
          <div className="chain-sub">{nodes.length} token{nodes.length === 1 ? "" : "s"}</div>
        </div>
        <button className="danger" onClick={onDelete}>Delete</button>
      </div>

      <div className="row">
        <label htmlFor={`ar-${chain.id}`}>Auto-rotate tokens</label>
        <input id={`ar-${chain.id}`} type="checkbox"
          checked={chain.settings.autoRotate}
          onChange={(e) => toggle("autoRotate", e.target.checked)} />
      </div>
      {chain.settings.autoRotate && (
        <div className="row">
          <label htmlFor={`ro-${chain.id}`}>Rotation offset (°)</label>
          <input id={`ro-${chain.id}`} type="number" step={15} className="num"
            value={offset}
            onChange={(e) => onOffset(Number(e.target.value) || 0)} />
        </div>
      )}
      <div className="row">
        <label htmlFor={`sc-${chain.id}`}>Show connector lines</label>
        <input id={`sc-${chain.id}`} type="checkbox"
          checked={chain.settings.showConnectors}
          onChange={(e) => toggle("showConnectors", e.target.checked)} />
      </div>
      <div className="row">
        <label htmlFor={`pp-${chain.id}`}>Players may pose</label>
        <input id={`pp-${chain.id}`} type="checkbox"
          checked={chain.settings.playerPosable}
          onChange={(e) => toggle("playerPosable", e.target.checked)} />
      </div>
      <div className="row">
        <span className="chain-sub">Re-measure rest lengths from current spacing</span>
        <button onClick={onRecalibrate}>Recalibrate</button>
      </div>

      <div className="nodes">
        <div className="nodes-title">Tokens</div>
        {nodes.map(({ id, depth }) => {
          const isRoot = id === chain.rootId;
          const node = chain.nodes[id];
          const ov = chain.settings.nodeOverrides?.[id] ?? {};
          // Root defaults to NOT player-movable; others follow the chain setting.
          const playerMovable = ov.playerMovable ?? !isRoot;
          // A bend limit needs a reference bone above the joint, so it only
          // applies where a grandparent exists (parent is not the root).
          const canBend = !isRoot && node?.parentId != null && node.parentId !== chain.rootId;
          const constraint = node?.constraint;
          return (
            <div className="node" key={id} style={{ paddingLeft: 8 + depth * 14 }}>
              <div className="node-main">
                <span className="node-name">
                  {isRoot ? "⚓ " : depth > 0 ? "› " : ""}
                  {names[id] ?? id.slice(0, 8)}
                </span>
                {isRoot && <span className="badge">root</span>}
              </div>
              <div className="node-ctl">
                {chain.settings.playerPosable && (
                  <label className="mini" title="Players may move this node">
                    <input type="checkbox" checked={playerMovable}
                      onChange={(e) => onNodeOverride(id, { playerMovable: e.target.checked })} />
                    player
                  </label>
                )}
                <label className="mini" title="Pin this node (nobody can grab it)">
                  <input type="checkbox" checked={ov.locked ?? false}
                    onChange={(e) => onNodeOverride(id, { locked: e.target.checked || undefined })} />
                  lock
                </label>
                {canBend && (
                  <label className="mini" title="Limit this joint's bend angle">
                    <input type="checkbox" checked={!!constraint}
                      onChange={(e) =>
                        onNodeConstraint(id, e.target.checked ? { minDeg: -120, maxDeg: 0 } : null)} />
                    bend
                  </label>
                )}
                <button className="mini-btn danger" title={isRoot ? "Delete whole chain" : "Remove node"}
                  onClick={() => onRemoveNode(id)}>✕</button>
              </div>
              {canBend && constraint && (
                <div className="node-bend">
                  <label className="mini" title="Minimum bend relative to the parent bone">
                    min°
                    <input type="number" step={15} className="num-sm" value={constraint.minDeg}
                      onChange={(e) =>
                        onNodeConstraint(id, { ...constraint, minDeg: Number(e.target.value) || 0 })} />
                  </label>
                  <label className="mini" title="Maximum bend relative to the parent bone">
                    max°
                    <input type="number" step={15} className="num-sm" value={constraint.maxDeg}
                      onChange={(e) =>
                        onNodeConstraint(id, { ...constraint, maxDeg: Number(e.target.value) || 0 })} />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
