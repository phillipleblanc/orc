/** Edit the current Orc session's notes with nvim inside Pi. The app shows the same file. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The runtime's session-name rule; names are also file names.
function validName(name: string | undefined): name is string {
  return !!name && name.length <= 64 && !name.startsWith(".") && !/[\/\u0000-\u001f\u007f]/.test(name);
}

function noteFile(name: string): string {
  const config = process.env.ORC_CONFIG_DIR || join(homedir(), ".config", "orc");
  return join(config, "notes", `${name}.txt`);
}

async function openNvim(file: string, ui: any): Promise<number | null> {
  return ui.custom(async (tui: any, _theme: unknown, _keys: unknown, done: (result: number | null) => void) => {
    tui.stop();
    let status: number | null = null;
    try {
      status = await new Promise<number | null>((resolve) => {
        const child = spawn("nvim", [file], { stdio: "inherit" });
        child.once("error", () => resolve(null));
        child.once("close", (code) => resolve(code));
      });
    } finally {
      tui.start();
      tui.requestRender(true);
      done(status);
    }
    return { render: () => [], invalidate: () => {} };
  });
}

export default function (pi: any): void {
  pi.registerCommand("notes", {
    description: "Edit this Orc session's notes in nvim",
    handler: async (_args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/notes needs an interactive Pi terminal.", "error");
        return;
      }
      const name = process.env.ORC_SESSION_NAME;
      if (!validName(name)) {
        ctx.ui.notify("/notes works in Pi sessions started by Orc.", "error");
        return;
      }
      try {
        const file = noteFile(name);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const status = await openNvim(file, ctx.ui);
        if (status !== 0) ctx.ui.notify("nvim did not save the note successfully.", "error");
      } catch (error) {
        ctx.ui.notify(`Could not open session notes: ${String(error)}`, "error");
      }
    },
  });
}
