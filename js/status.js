import { dom } from "./dom.js";

export function setStatus(text, level = "ok") {
  const dotClass = level === "err" ? "dot err" : level === "warn" ? "dot warn" : "dot";
  dom.statusEl.innerHTML = `<span class="${dotClass}"></span>${text}`;
}
