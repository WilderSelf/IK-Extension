import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { ChainMap } from "../types";
import {
  deleteChain,
  getChains,
  onChainsChange,
  recalibrate,
  saveChains,
  updateSettings,
} from "../obr/chainStore";
import { getPositions } from "../obr/scene";

export function SidebarApp() {
  const [chains, setChains] = useState<ChainMap>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unsub = () => {};
    OBR.onReady(() => {
      setReady(true);
      getChains().then(setChains).catch(() => {});
      unsub = onChainsChange(setChains);
    });
    return () => unsub();
  }, []);

  async function patch(next: ChainMap) {
    setChains(next);
    await saveChains(next);
  }

  async function onToggle(chainId: string, key: "autoRotate" | "showConnectors" | "playerPosable", value: boolean) {
    await patch(updateSettings(chains, chainId, { [key]: value }));
  }

  async function onDelete(chainId: string) {
    await patch(deleteChain(chains, chainId));
  }

  async function onRecalibrate(chainId: string) {
    const ids = Object.keys(chains[chainId]?.nodes ?? {});
    const positions = await getPositions(ids);
    await patch(recalibrate(chains, chainId, positions));
  }

  const list = Object.values(chains);

  return (
    <div>
      <h1>IK Chains</h1>
      <p className="hint">
        Build articulated token chains and pose them like limbs.
        <ol>
          <li>Select the <strong>IK Chains</strong> tool, then its <strong>Build</strong> mode.</li>
          <li>Click a token to set the <strong>root</strong>, then click tokens outward to link them.</li>
          <li>Click an existing node to branch from it.</li>
          <li>Switch to <strong>Pose</strong> mode and drag any token — the chain flexes, root pinned.</li>
        </ol>
      </p>

      {!ready && <p className="empty">Connecting to Owlbear Rodeo…</p>}
      {ready && list.length === 0 && <p className="empty">No chains yet.</p>}

      {list.map((chain) => {
        const count = Object.keys(chain.nodes).length;
        return (
          <div className="chain" key={chain.id}>
            <div className="chain-header">
              <div>
                <div className="chain-title">Chain {chain.id.replace(/^chain_/, "")}</div>
                <div className="chain-sub">{count} token{count === 1 ? "" : "s"}</div>
              </div>
              <button className="danger" onClick={() => onDelete(chain.id)}>
                Delete
              </button>
            </div>

            <div className="row">
              <label htmlFor={`ar-${chain.id}`}>Auto-rotate tokens</label>
              <input
                id={`ar-${chain.id}`}
                type="checkbox"
                checked={chain.settings.autoRotate}
                onChange={(e) => onToggle(chain.id, "autoRotate", e.target.checked)}
              />
            </div>
            <div className="row">
              <label htmlFor={`sc-${chain.id}`}>Show connector lines</label>
              <input
                id={`sc-${chain.id}`}
                type="checkbox"
                checked={chain.settings.showConnectors}
                onChange={(e) => onToggle(chain.id, "showConnectors", e.target.checked)}
              />
            </div>
            <div className="row">
              <label htmlFor={`pp-${chain.id}`}>Players may pose</label>
              <input
                id={`pp-${chain.id}`}
                type="checkbox"
                checked={chain.settings.playerPosable}
                onChange={(e) => onToggle(chain.id, "playerPosable", e.target.checked)}
              />
            </div>
            <div className="row">
              <span className="chain-sub">Re-measure rest lengths from current spacing</span>
              <button onClick={() => onRecalibrate(chain.id)}>Recalibrate</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
