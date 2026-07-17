export const ID = "rodeo.wilder.ik";

export const TOOL_ID = `${ID}/tool`;
export const MODE_POSE = `${ID}/pose`;
export const MODE_BUILD = `${ID}/build`;

export const CTX_SET_ROOT = `${ID}/set-root`;
export const CTX_REMOVE = `${ID}/remove`;

export const CONNECTOR_TAG = `${ID}/connector`;

/** Item layers we treat as riggable tokens. */
export const TOKEN_LAYERS = new Set(["CHARACTER", "MOUNT", "PROP", "ATTACHMENT"]);
