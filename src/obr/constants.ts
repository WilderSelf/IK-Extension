export const ID = "rodeo.wilder.ik";

export const TOOL_ID = `${ID}/tool`;
export const MODE_POSE = `${ID}/pose`;
export const MODE_BUILD = `${ID}/build`;

export const CTX_SET_ROOT = `${ID}/set-root`;
export const CTX_REMOVE = `${ID}/remove`;

export const CONNECTOR_TAG = `${ID}/connector`;

/**
 * Degrees added when converting a bone's math angle to an OBR item rotation.
 * Tokens conventionally point "up", so a bone pointing along +x (angle 0)
 * needs +90° to make the art face down the limb. Tune per art if needed.
 */
export const ROTATION_OFFSET_DEG = 90;

/** Item layers we treat as riggable tokens. */
export const TOKEN_LAYERS = new Set(["CHARACTER", "MOUNT", "PROP", "ATTACHMENT"]);
