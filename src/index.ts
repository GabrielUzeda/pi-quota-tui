// pi-quota-tui: AI subscription quotas as an ANSI list in the pi widget.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loginAgy } from "./agy-login.ts";
import { report, resolveSource, SOURCE_NAMES } from "./format.ts";
import { QuotaPanel } from "./panel.ts";
import type { Snapshot } from "./models.ts";
import { nowSec } from "./providers.ts";
import { Monitor } from "./service.ts";

const WIDGET = "pi-quota-tui-quotas";

export default function (pi: ExtensionAPI) {
  const monitor = new Monitor();
  let shown = false;

  // Widget below the editor: reserves layout lines instead of covering the chat.
  const showPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET, (_tui, theme) => new QuotaPanel(monitor, theme), { placement: "belowEditor" });
    shown = true;
  };

  // setWidget(undefined) unmounts the dock panel.
  const hidePanel = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    shown = false;
  };

  const toggle = (ctx: ExtensionContext) => (shown ? hidePanel(ctx) : showPanel(ctx));

  const quotas = async (source: string) => {
    await monitor.refresh();
    const { provider } = resolveSource(source);
    const snapshots: Snapshot[] = provider ? monitor.snapshots(provider) : monitor.snapshots();
    return report(snapshots, nowSec());
  };

  pi.on("session_start", (_event, ctx) => {
    monitor.start();
    showPanel(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hidePanel(ctx);
    monitor.stop();
  });

  pi.registerEntryRenderer("quota-report", (entry: { data?: { content?: string } }) =>
    new Markdown(entry.data?.content ?? "No quota data.", 1, 1, getMarkdownTheme()));

  const reportCommand = async (args: string | undefined, ctx: ExtensionContext) => {
    const source = args?.trim() || "all";
    if (!resolveSource(source).valid) return ctx.ui.notify("Sources: " + SOURCE_NAMES.join(", "), "error");
    ctx.ui.notify("Reading quotas...", "info");
    // appendEntry shows it in the TUI without feeding the LLM context.
    pi.appendEntry("quota-report", { content: await quotas(source) });
  };

  pi.registerCommand("quota", {
    description: "Quota report [all|opencode|agy|commandcode]",
    handler: reportCommand,
  });
  pi.registerCommand("usage", {
    description: "Alias of /quota",
    handler: reportCommand,
  });
  pi.registerCommand("quota-login", {
    description: "Imports the Antigravity accounts from AGY or runs the Google login",
    handler: async (_args, ctx) => {
      try {
        await loginAgy((message, level) => ctx.ui.notify(message, level ?? "info"));
        await monitor.refresh();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Antigravity login failed.", "error");
      }
    },
  });

  pi.registerCommand("quotas", {
    description: "Shows or hides the quota panel",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerTool({
    name: "get_quotas",
    label: "Get Quotas Summary",
    description: "Reads usage and remaining quota of OpenCode Go, Antigravity, OpenAI Codex, Claude Code and CommandCode.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("opencode"), Type.Literal("agy"), Type.Literal("commandcode")],
          { description: "Quota source to read (all, opencode, agy, commandcode)" },
        ),
      ),
    }),
    async execute(_id, params) {
      const source = params.source ?? "all";
      if (!resolveSource(source).valid)
        return { content: [{ type: "text", text: "Unknown source: " + source + ". Use: " + SOURCE_NAMES.join(", ") + "." }], details: { source } };
      return { content: [{ type: "text", text: await quotas(source) }], details: { source } };
    },
  });
}
