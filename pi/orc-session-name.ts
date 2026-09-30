/** Give a Pi session running in Orc the Orc session's name. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const name = process.env.ORC_SESSION_NAME;
  if (!name) return;
  pi.on("session_start", () => {
    if ((pi.getSessionName() ?? "") !== name) pi.setSessionName(name);
  });
}
