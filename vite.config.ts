import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two HTML entry points (paths are resolved relative to the project root):
//  - index.html      → the action popover (sidebar UI)
//  - background.html → the always-loaded page that registers the tool / menus
export default defineConfig({
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
