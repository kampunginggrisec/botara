/**
 * Meta platform deprecation calendar.
 * Dates verified against Meta's announcements on 2026-10-22.
 * The platform must warn operators BEFORE these dates, not after.
 */
export interface DeprecationEvent {
  date: string; // ISO date (YYYY-MM-DD)
  surface: string;
  title: string;
  detail: string;
  action: string;
}

export const META_DEPRECATIONS: DeprecationEvent[] = [
  {
    date: "2026-10-27",
    surface: "Graph API",
    title: "Commerce Order Management API removed from all versions",
    detail: "Blocked on v26.0+ since 2026-07-29; removed everywhere on this date. No replacement API.",
    action: "Do not build shop-order features on the Commerce API.",
  },
  {
    date: "2027-01-21",
    surface: "Graph API",
    title: "Graph API v21.0 removed",
    detail: "Each Graph API version lives at least two years. v20.0 was removed 2026-09-24.",
    action: "Pin META_GRAPH_VERSION=v26.0 and keep every adapter on a supported version.",
  },
  {
    date: "2027-04-13",
    surface: "WhatsApp",
    title: "New messaging accounts lose Cloud API marketing",
    detail: "Messaging accounts created on/after this date cannot send marketing messages via the Cloud API at all.",
    action: "Route marketing via the Marketing Messages API from day one.",
  },
  {
    date: "2027-10-13",
    surface: "WhatsApp",
    title: "Marketing messages sunset on the WhatsApp Cloud API",
    detail: "Announced 2026-10-21. Marketing templates must go through the Marketing Messages API for WhatsApp.",
    action: "Implement dual-API routing by template latest_category (ADR-008).",
  },
];

export function upcomingDeprecations(from = new Date()): DeprecationEvent[] {
  return META_DEPRECATIONS.filter((e) => new Date(e.date) >= from).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}
