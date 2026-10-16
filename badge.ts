// Draws Radar's unseen-item count on its nav-rail button. bb does not mount
// navPanel sidebar accessories yet, so this decorates the rail from a content
// script and polls the plugin's local `badge` route (in-memory, cheap).
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const BUTTON = 'nav button[aria-label="Radar"]';
const ATTR = "data-radar-badge";
const POLL_MS = 15_000;

export function mountRailBadge(context: PluginContentScriptContext): () => void {
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const paint = () => {
    for (const button of document.querySelectorAll<HTMLElement>(BUTTON)) {
      let badge = button.querySelector<HTMLElement>(`[${ATTR}]`);
      if (count === 0) {
        badge?.remove();
        button.removeAttribute("aria-description");
        continue;
      }
      if (badge === null) {
        badge = document.createElement("span");
        badge.setAttribute(ATTR, "");
        badge.className = "radar-rail-badge";
        badge.setAttribute("aria-hidden", "true");
        button.append(badge);
      }
      // Inline, not a class: React rewrites the button's className on re-render.
      if (button.style.position !== "relative") button.style.position = "relative";
      const text = count > 99 ? "99+" : String(count);
      if (badge.textContent !== text) badge.textContent = text;
      button.setAttribute("aria-description", `${count} new in Radar`);
    }
  };

  const poll = async () => {
    try {
      const response = await fetch(`/api/v1/plugins/${context.pluginId}/http/badge`, {
        signal: context.signal,
        headers: { accept: "application/json" },
      });
      if (response.ok) {
        const body = (await response.json()) as { new?: unknown };
        count = typeof body.new === "number" ? body.new : 0;
        paint();
      }
    } catch {
      // Server restarting or plugin reloading; keep the last count.
    }
    if (!context.signal.aborted) timer = setTimeout(() => void poll(), document.hidden ? POLL_MS * 4 : POLL_MS);
  };

  // The rail re-renders (route changes, compact-nav); re-attach when it does.
  const observer = new MutationObserver(() => {
    if (count === 0) return;
    for (const button of document.querySelectorAll<HTMLElement>(BUTTON)) {
      if (button.style.position !== "relative" || button.querySelector(`[${ATTR}]`) === null) return paint();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  const onVisible = () => {
    if (!document.hidden) {
      clearTimeout(timer);
      void poll();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  void poll();

  return () => {
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
    for (const badge of document.querySelectorAll(`[${ATTR}]`)) badge.remove();
    for (const button of document.querySelectorAll<HTMLElement>(BUTTON)) {
      button.style.removeProperty("position");
      button.removeAttribute("aria-description");
    }
  };
}
