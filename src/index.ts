// pi-quota-tui: AI subscription quotas as an ANSI list in the pi widget.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loginAgy } from "./agy-login.ts";
import { configPath, DEFAULTS, loadConfig, saveConfig, type Config } from "./config.ts";
import { editConfig } from "./config-menu.ts";
import { report, resolveSource, SOURCE_NAMES } from "./format.ts";
import { QuotaPanel } from "./panel.ts";
import type { Snapshot } from "./models.ts";
import { nowSec, setOAuthRefresh } from "./providers.ts";
import { Monitor } from "./service.ts";

const WIDGET = "pi-quota-tui-quotas";

export default function (pi: ExtensionAPI) {
  const monitor = new Monitor();
  let config: Config = DEFAULTS;
  let shown = false;
  let stopAuth: (() => void) | undefined;

  // Widget next to the editor: reserves layout lines instead of covering the chat.
  const showPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const options = config;
    // The panel reads only when pi renders it, so a finished collection asks for one.
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      monitor.onUpdate = () => tui.requestRender();
      return new QuotaPanel(monitor, theme, options);
    }, { placement: options.placement });
    shown = true;
  };

  // setWidget(undefined) unmounts the dock panel.
  const hidePanel = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    monitor.onUpdate = undefined;
    shown = false;
  };

  const toggle = (ctx: ExtensionContext) => (shown ? hidePanel(ctx) : showPanel(ctx));

  const quotas = async (source: string) => {
    await monitor.refresh();
    const { provider } = resolveSource(source);
    const snapshots: Snapshot[] = provider ? monitor.snapshots(provider) : monitor.snapshots();
    return report(snapshots, nowSec());
  };

  pi.on("session_start", async (_event, ctx) => {
    // pi refreshes the OAuth token only while a model runs; asking the registry keeps the read alive.
    stopAuth?.();
    stopAuth = setOAuthRefresh(async (provider) => (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey);
    const loaded = await loadConfig();
    config = loaded.config;
    if (loaded.error && ctx.hasUI) ctx.ui.notify(loaded.error, "warning");
    monitor.configure(config);
    monitor.start();
    if (config.showOnStart) showPanel(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hidePanel(ctx);
    monitor.stop();
    // Drops this session's token source: another session keeps its own.
    stopAuth?.();
    stopAuth = undefined;
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

  pi.registerCommand("quota-config", {
    description: "Edits the panel preferences (saved to pi-quota-tui.json in the pi agent dir)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      // Re-reads the file so hand edits show up in the menu.
      const loaded = await loadConfig();
      if (loaded.error) ctx.ui.notify(loaded.error + " Saving keeps a copy in " + configPath() + ".bak.", "warning");
      const edited = await editConfig(ctx.ui, loaded.config);
      if (!edited) return ctx.ui.notify("Settings not saved.", "info");
      try {
        await saveConfig(edited);
      } catch {
        return ctx.ui.notify("Could not write " + configPath() + ".", "error");
      }
      config = edited;
      monitor.configure(config);
      if (shown) showPanel(ctx);
      void monitor.refresh();
      ctx.ui.notify("Saved to " + configPath() + ".", "info");
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
