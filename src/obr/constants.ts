export const ID = "rodeo.wilder.ik";

export const TOOL_ID = `${ID}/tool`;
export const MODE_POSE = `${ID}/pose`;

export const CTX_REMOVE = `${ID}/remove`;

/** Metadata flag tagging our local-only on-canvas chain-highlight shapes. */
export const HIGHLIGHT_META = `${ID}/highlight`;

/**
 * Tool-activation hotkey (a single Owlbear tool `shortcut`). Chosen to avoid
 * Owlbear's built-in tool keys (W/F/D/M/Q/N) and fog/draw sub-mode keys; a bare
 * letter is never a browser shortcut. Displayed as one letter to the user.
 */
export const POSE_SHORTCUT = "K";

/**
 * Resolve a bundled public asset (icon SVG) against the site's base path.
 * Owlbear loads tool/menu icons by URL relative to the site origin, so on a
 * GitHub Pages project site (served from `/IK-Extension/`) a bare `/icon.svg`
 * would 404. `import.meta.env.BASE_URL` is the Vite `base` ("/IK-Extension/"),
 * baked in at build time, so icons resolve wherever the extension is hosted.
 */
export const asset = (file: string): string => `${import.meta.env.BASE_URL}${file}`;

/** Item layers we treat as riggable tokens (fog, drawings, etc. are excluded). */
export const TOKEN_LAYERS = new Set(["CHARACTER", "MOUNT", "PROP", "ATTACHMENT"]);
