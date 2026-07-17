import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { Chain, ChainMap, JointConstraint } from "../types";
import { DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import type { TemplateMap } from "../model/templates";
import {
  type History,
  canRedo,
  canUndo,
  initHistory,
  record,
  redo,
  undo,
} from "../model/history";
import {
  deleteChain,
  deleteTemplate,
  getChains,
  getTemplates,
  instantiateTemplate,
  onChainsChange,
  onTemplatesChange,
  recalibrate,
  removeToken,
  saveChains,
  saveTemplate,
  saveTemplates,
  setNodeConstraint,
  setNodeOverride,
  toTemplate,
  updateSettings,
} from "../obr/chainStore";
import { getItemNames, getPositions, getSelection } from "../obr/scene";
import { orderedNodes } from "../ik/tree";

const mapEq = (a: ChainMap, b: ChainMap) => JSON.stringify(a) === JSON.stringify(b);

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [templates, setTemplates] = useState<TemplateMap>({});
  const [history, setHistory] = useState<History<ChainMap>>(() => initHistory({}));
  const [names, setNames] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unsubChains = () => {};
    let unsubTemplates = () => {};
    OBR.onReady(() => {
      // The component may have unmounted while onReady was pending; don't set
      // state on a dead component and make sure the subscriptions are cleaned up.
      if (!mounted) return;
      setReady(true);
      getChains()
        .then((c) => {
          if (!mounted) return;
          setChains(c);
          setHistory(initHistory(c)); // baseline: undo shouldn't reach before load
        })
        .catch(() => {});
      getTemplates().then((t) => mounted && setTemplates(t)).catch(() => {});
      // Every chain change (from here, the tool, or the context menu) is recorded
      // so undo/redo covers all rig edits, not just sidebar ones. Echoes of our
      // own writes are ignored by `record` (value-equal to the present).
      unsubChains = onChainsChange((c) => {
        setChains(c);
        setHistory((h) => record(h, c, mapEq));
      });
      unsubTemplates = onTemplatesChange(setTemplates);
    });
    return () => {
      mounted = false;
      unsubChains();
      unsubTemplates();
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

  // Undo/redo write a previous snapshot back to the scene. The resulting change
  // echoes through onChainsChange, but `record` treats it as a no-op (value-equal
  // to the present we just set), so the redo stack survives.
  async function applyHistory(nextH: History<ChainMap>) {
    setHistory(nextH);
    setChains(nextH.present);
    await saveChains(nextH.present);
  }
  const onUndo = () => applyHistory(undo(history));
  const onRedo = () => applyHistory(redo(history));

  async function patchTemplates(next: TemplateMap) {
    setTemplates(next);
    await saveTemplates(next);
  }

  const onSavePreset = async (chain: Chain, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await patchTemplates(saveTemplate(templates, trimmed, toTemplate(chain)));
    setNotice(`Saved preset "${trimmed}".`);
  };

  const onDeletePreset = (name: string) => patchTemplates(deleteTemplate(templates, name));

  const onApplyPreset = async (name: string) => {
    const template = templates[name];
    if (!template) return;
    const selection = await getSelection();
    const need = template.nodes.length;
    if (selection.length !== need) {
      setNotice(
        `Select ${need} token${need === 1 ? "" : "s"} (root first, outward) to apply "${name}" — ${selection.length} selected.`,
      );
      return;
    }
    const result = instantiateTemplate(template, selection, chains);
    if (!result) {
      setNotice(`Couldn't apply "${name}" — the selection has duplicates.`);
      return;
    }
    await patch(result[0]);
    setNotice(`Applied "${name}" to the selection.`);
  };

  const list = Object.values(chains);
  const presetNames = Object.keys(templates).sort();

  return (
    <div>
      <div className="app-header">
        <h1>IK Chains</h1>
        {ready && (
          <span className="undo-redo">
            <button className="mini-btn" title="Undo the last rig change"
              disabled={!canUndo(history)} onClick={onUndo}>↶ Undo</button>
            <button className="mini-btn" title="Redo"
              disabled={!canRedo(history)} onClick={onRedo}>↷ Redo</button>
          </span>
        )}
      </div>
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

      {notice && (
        <p className="notice" role="status" onClick={() => setNotice("")}>
          {notice}
        </p>
      )}

      {list.map((chain) => (
        <ChainCard
          key={chain.id}
          chain={chain}
          names={names}
          onPatch={patch}
          onSavePreset={onSavePreset}
          chains={chains}
        />
      ))}

      {presetNames.length > 0 && (
        <div className="presets">
          <div className="presets-title">Presets</div>
          <p className="hint">
            Reuse a rig on another creature: select its tokens (root first, then
            outward in the same order) and apply.
          </p>
          {presetNames.map((name) => (
            <div className="row preset-row" key={name}>
              <span className="preset-name" title={`${templates[name].nodes.length} nodes`}>
                {name} <span className="chain-sub">({templates[name].nodes.length})</span>
              </span>
              <span className="preset-actions">
                <button onClick={() => onApplyPreset(name)}>Apply</button>
                <button className="mini-btn danger" title="Delete preset"
                  onClick={() => onDeletePreset(name)}>✕</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChainCard({
  chain,
  chains,
  names,
  onPatch,
  onSavePreset,
}: {
  chain: Chain;
  chains: ChainMap;
  names: Record<string, string>;
  onPatch: (next: ChainMap) => Promise<void>;
  onSavePreset: (chain: Chain, name: string) => void | Promise<void>;
}) {
  const [presetName, setPresetName] = useState("");
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
      <div className="row">
        <input className="preset-input" type="text" placeholder="Preset name"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)} />
        <button disabled={!presetName.trim()}
          onClick={() => { onSavePreset(chain, presetName); setPresetName(""); }}>
          Save as preset
        </button>
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
