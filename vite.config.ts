import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two HTML entry points (paths are resolved relative to the project root):
//  - index.html      → the action popover (sidebar UI)
//  - background.html → the always-loaded page that registers the tool / menus
export default defineConfig({
  // Served from a GitHub Pages project site at https://wilderself.github.io/IK-Extension/,
  // so every asset URL (and the manifest's absolute paths) must carry the /IK-Extension/
  // prefix. Applies to the dev server too, so local + hosted URLs stay identical.
  base: "/IK-Extension/",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        background: "background.html",
      },
    },
  },
});
