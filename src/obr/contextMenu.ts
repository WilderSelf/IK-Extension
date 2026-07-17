import OBR from "@owlbear-rodeo/sdk";
import { CTX_REMOVE, CTX_SET_ROOT, asset } from "./constants";
import {
  createChain,
  findChainForToken,
  getChains,
  removeToken,
  saveChains,
} from "./chainStore";

export async function setupContextMenu(): Promise<void> {
  await OBR.contextMenu.create({
    id: CTX_SET_ROOT,
    icons: [
      {
        icon: asset("icon.svg"),
        label: "Set as IK Root",
        filter: {
          min: 1,
          max: 1,
          roles: ["GM"],
        },
      },
    ],
    async onClick(context) {
      const item = context.items[0];
      if (!item) return;
      const chains = await getChains();
      if (findChainForToken(chains, item.id)) {
        await OBR.notification.show("That token is already in a chain", "WARNING");
        return;
      }
      const [next] = createChain(chains, item.id);
      await saveChains(next);
      await OBR.notification.show("IK root set — use the IK tool's Build mode to add tokens", "SUCCESS");
    },
  });

  await OBR.contextMenu.create({
    id: CTX_REMOVE,
    icons: [
      {
        icon: asset("icon.svg"),
        label: "Remove from IK Chain",
        filter: {
          min: 1,
          roles: ["GM"],
        },
      },
    ],
    async onClick(context) {
      let chains = await getChains();
      for (const item of context.items) {
        chains = removeToken(chains, item.id);
      }
      await saveChains(chains);
      await OBR.notification.show("Removed from IK chain", "SUCCESS");
    },
  });
}
