const UNITS: Array<[limit: number, seconds: number, unit: Intl.RelativeTimeFormatUnit]> = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [604_800, 86_400, "day"],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "in 4 minutes" / "2 hours ago". Falls back to a date once a week out, where a
 *  relative phrase stops being easier to read than the date itself. */
export function relativeTime(iso: string): string {
  const delta = (new Date(iso).getTime() - Date.now()) / 1000;
  const magnitude = Math.abs(delta);

  for (const [limit, seconds, unit] of UNITS) {
    if (magnitude < limit) return relative.format(Math.round(delta / seconds), unit);
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
