import OBR from "@owlbear-rodeo/sdk";
import { CTX_REMOVE, asset } from "./constants";
import { getChains, removeToken, saveChains } from "./chainStore";

/**
 * The single right-click action: remove a token from its chain. On the root
 * this deletes the whole chain; on an interior node it cuts the linear strand
 * there (dropping that node and everything past it). Whole-chain deletion is
 * also available from the popover's Delete button.
 *
 * No `OBR.notification` calls — feedback is the popover's live chain list, so
 * the top-center messaging area stays clear.
 */
export async function setupContextMenu(): Promise<void> {
  await OBR.contextMenu.create({
    id: CTX_REMOVE,
    icons: [
      {
        icon: asset("icon.svg"),
        label: "Remove from IK chain",
        filter: { min: 1, roles: ["GM"] },
      },
    ],
    async onClick(context) {
      let chains = await getChains();
      for (const item of context.items) {
        chains = removeToken(chains, item.id);
      }
      await saveChains(chains);
    },
  });
}
