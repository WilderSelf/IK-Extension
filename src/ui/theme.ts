import { useEffect, useState } from "react";
import OBR, { type Theme } from "@owlbear-rodeo/sdk";

/**
 * Mirror Owlbear's live theme into CSS custom properties on the document root,
 * so the sidebar matches the room's look (default dark, light, or a custom
 * palette) instead of shipping its own hard-coded colors. Colors come straight
 * from the SDK's theme API — no Owlbear brand assets are bundled.
 *
 * The variables (with the fallbacks baked into styles.css) are the single source
 * of truth for every color in the UI, so a theme change re-tints the whole
 * sidebar without a reload.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);

  root.style.colorScheme = theme.mode === "LIGHT" ? "light" : "dark";
  set("--ik-bg", theme.background.default);
  set("--ik-paper", theme.background.paper);
  set("--ik-text", theme.text.primary);
  set("--ik-text-secondary", theme.text.secondary);
  set("--ik-text-disabled", theme.text.disabled);
  set("--ik-primary", theme.primary.main);
  set("--ik-primary-contrast", theme.primary.contrastText);
}

export function useObrTheme(): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsub = () => {};
    OBR.onReady(() => {
      if (!mounted) return;
      OBR.theme
        .getTheme()
        .then((t) => {
          if (!mounted) return;
          applyTheme(t);
          setTheme(t);
        })
        .catch(() => {});
      unsub = OBR.theme.onChange((t) => {
        applyTheme(t);
        setTheme(t);
      });
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  return theme;
}
