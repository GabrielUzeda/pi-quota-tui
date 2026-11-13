// Polling independent of the panel. Temporary failures keep the last reading, marked as old.
import { COLLECTORS, ReadError } from "./providers.ts";
import type { Snapshot } from "./models.ts";

const INTERVAL_MS = 120_000;
const COLLECT_TIMEOUT_MS = 25_000;
const PENDING = "Waiting for the first read.";
const GENERIC = "Internal read failure; last quota kept.";
export const NAMES: Record<string, string> = {
  antigravity: "Antigravity",
  opencode: "OpenCode Go",
  openai: "OpenAI Codex",
  claude: "Claude Code",
  commandcode: "CommandCode",
};

type Collector = () => Promise<Snapshot[]>;

export class Monitor {
  private readonly collectors: Record<string, Collector>;
  private readonly timeoutMs: number;
  private intervalMs = INTERVAL_MS;
  private hidden = new Set<string>();
  private data = new Map<string, Snapshot[]>();
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  /** Called after every provider update; the panel asks pi for a redraw with it. */
  onUpdate?: () => void;

  constructor(collectors: Record<string, Collector> = COLLECTORS, timeoutMs = COLLECT_TIMEOUT_MS) {
    this.collectors = collectors;
    this.timeoutMs = timeoutMs;
    for (const id of Object.keys(collectors))
      this.data.set(id, [{ id, name: NAMES[id] ?? id, windows: [], source: "", error: PENDING, disabled: true }]);
  }

  /** Starts a collection on every provider; if one is already running, reuses it. */
  refresh(): Promise<void> {
    this.inFlight ??= this.collectAll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Applies the user preferences; a running poll restarts with the new interval. */
  configure(options: { refreshSeconds: number; hiddenProviders: readonly string[] }): void {
    this.intervalMs = options.refreshSeconds * 1000;
    const hidden = new Set(options.hiddenProviders);
    // A read already running started without the providers that become visible only now.
    const revealed = [...this.hidden].filter((id) => !hidden.has(id) && this.collectors[id]);
    this.hidden = hidden;
    if (revealed.length) void this.collectLater(revealed);
    if (!this.timer) return;
    this.stop();
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshots(provider?: string): Snapshot[] {
    if (provider) return this.hidden.has(provider) ? [] : this.data.get(provider) ?? [];
    return [...this.data].filter(([id]) => !this.hidden.has(id)).flatMap(([, snapshots]) => snapshots);
  }

  private async collectAll(): Promise<void> {
    // Hidden providers are not even collected: no network call, no subprocess.
    const active = Object.entries(this.collectors).filter(([id]) => !this.hidden.has(id));
    await Promise.all(active.map(([id, collect]) => this.run(id, collect)));
  }

  /** Each provider is isolated: a failure or unexpected answer from one does not affect the others. */
  private async run(id: string, collect: Collector): Promise<void> {
    try {
      this.apply(id, await withTimeout(collect(), this.timeoutMs));
    } catch (reason) {
      this.fail(id, safeMessage(reason));
    } finally {
      this.onUpdate?.();
    }
  }

  /** Waits for the read in flight: reusing it would leave a revealed provider pending until the next cycle. */
  private async collectLater(ids: string[]): Promise<void> {
    await this.inFlight;
    await Promise.all(ids.map((id) => this.run(id, this.collectors[id])));
  }

  private apply(provider: string, fresh: Snapshot[]): void {
    const current = this.data.get(provider) ?? [];
    if (fresh.length && fresh.every((s) => s.disabled)) {
      this.data.set(provider, fresh);
      return;
    }
    if (!fresh.some((s) => s.windows.length && !s.error)) {
      if (fresh.length && !current.some((s) => s.windows.length)) this.data.set(provider, fresh);
      else this.fail(provider, fresh[0]?.error ?? "No reading available.");
      return;
    }
    const previous = new Map(current.filter((s) => s.windows.length).map((s) => [s.id, s]));
    const merged: Snapshot[] = fresh.map((snapshot) => {
      const old = previous.get(snapshot.id);
      previous.delete(snapshot.id);
      return !snapshot.windows.length && old ? { ...old, stale: true, error: snapshot.error } : snapshot;
    });
    for (const old of previous.values())
      merged.push({ ...old, stale: true, error: "Account missing from the current read." });
    this.data.set(provider, merged);
  }

  private fail(provider: string, message: string): void {
    const current = this.data.get(provider) ?? [];
    this.data.set(
      provider,
      current.map((s) => ({ ...s, disabled: false, stale: s.windows.length > 0, error: message })),
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadError("Query exceeded the time limit.")), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Only the ReadError message reaches the screen; any other error becomes generic text. */
function safeMessage(reason: unknown): string {
  return reason instanceof ReadError ? reason.message : GENERIC;
}
