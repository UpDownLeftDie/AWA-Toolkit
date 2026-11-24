export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

// AWA credits 1 Watch Twitch ARP per minute (1 ARP/min).
export const TWITCH_MS_PER_ARP = MS_PER_MINUTE;

// Wall-clock ms needed to earn one full day of Time on Site ARP.
// `basePerDay` is the unbuffed daily base (e.g. `BASE_ACTIVITY.timeOnSiteBasePerDay`).
export function timeOnSiteDurationMs(basePerDay: number): number {
  return basePerDay * MS_PER_MINUTE;
}
