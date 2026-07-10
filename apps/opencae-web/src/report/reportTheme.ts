export const REPORT_THEME = {
  ink: "#0b0f14",
  inkMuted: "#57606a",
  accent: "#1f6fd0",
  accentSoft: "#e8f1fc",
  hairline: "#d8dee4",
  success: "#15803d",
  successSoft: "#e9f8ee",
  warning: "#b45309",
  warningSoft: "#fff7e6",
  error: "#b91c1c",
  errorSoft: "#fdf0f0",
  ramp: ["#0759d6", "#0ea5e9", "#22c55e", "#facc15", "#f97316", "#ef4444"]
} as const;

export const REPORT_LAYOUT = {
  margin: 18,
  footerHeight: 11,
  sectionKeepTogether: 30
} as const;

export const REPORT_TYPE = {
  title: 22,
  section: 13,
  body: 9.5,
  caption: 8,
  keyValue: 14
} as const;
