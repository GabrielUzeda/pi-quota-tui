// Normalized data: never stores credentials or raw responses.

export interface Window {
  label: string;
  /** Percentage used, 0..100. */
  used: number;
  resetsAt?: number;
  /** Seconds of the cycle; without it the window has no pace and no forecast. */
  duration?: number;
  group?: string;
  estimated?: boolean;
}

export interface Snapshot {
  id: string;
  name: string;
  windows: Window[];
  updatedAt?: number;
  source: string;
  error?: string;
  stale?: boolean;
  note?: string;
  disabled?: boolean;
}

export function outdated(s: Snapshot, now: number): boolean {
  if (s.disabled) return false;
  return (
    !!s.stale ||
    !!s.error ||
    s.updatedAt === undefined ||
    s.updatedAt > now + 60 ||
    now - s.updatedAt > 120 ||
    s.windows.some((w) => w.resetsAt !== undefined && w.resetsAt <= now)
  );
}
