import type { CSSProperties } from "react";

/*
 * The email carries the same palette as the product: paper, ink, one indigo accent,
 * and mono strictly for machine data (the action, the digests). Values are hex
 * literals rather than tokens.css imports because email clients get inline styles
 * only — but they are the SAME hexes packages/theme owns, transcribed.
 */
export const colors = {
  paper: "#ecedeb",
  card: "#f8f9f7",
  ink: "#15181a",
  body: "#4a5250",
  muted: "#6b7472",
  border: "#d9dbd7",
  well: "#e7e9e6",
  primary: "#3d2fd6",
  primaryForeground: "#ecedeb",
  destructive: "#b3341f",
  destructiveWash: "#f6e9e6",
};

const sans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Roboto, sans-serif';
const mono =
  'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, monospace';

export const styles = {
  main: {
    backgroundColor: colors.paper,
    fontFamily: sans,
    margin: 0,
    padding: 0,
  } as CSSProperties,

  container: {
    margin: "0 auto",
    padding: "32px 16px 48px",
    maxWidth: "560px",
  } as CSSProperties,

  wordmark: {
    color: colors.ink,
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    margin: "0 0 20px",
  } as CSSProperties,

  card: {
    backgroundColor: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: "12px",
    padding: "28px",
  } as CSSProperties,

  kicker: {
    color: colors.muted,
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.09em",
    textTransform: "uppercase" as const,
    margin: "0 0 10px",
  } as CSSProperties,

  actionName: {
    color: colors.ink,
    fontFamily: mono,
    fontSize: "20px",
    fontWeight: 500,
    lineHeight: "28px",
    margin: "0 0 14px",
    wordBreak: "break-word" as const,
  } as CSSProperties,

  hero: {
    color: colors.ink,
    fontSize: "19px",
    fontWeight: 500,
    letterSpacing: "-0.01em",
    lineHeight: "28px",
    margin: "0 0 14px",
  } as CSSProperties,

  prose: {
    color: colors.body,
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 8px",
  } as CSSProperties,

  metaLine: {
    color: colors.muted,
    fontSize: "13px",
    lineHeight: "20px",
    margin: "14px 0 0",
  } as CSSProperties,

  highRisk: {
    backgroundColor: colors.destructiveWash,
    border: `1px solid ${colors.destructive}40`,
    borderRadius: "8px",
    padding: "12px 16px",
    margin: "18px 0 0",
  } as CSSProperties,

  highRiskText: {
    color: colors.destructive,
    fontSize: "13px",
    fontWeight: 500,
    lineHeight: "20px",
    margin: 0,
  } as CSSProperties,

  button: {
    backgroundColor: colors.primary,
    borderRadius: "8px",
    color: colors.primaryForeground,
    display: "block",
    fontSize: "15px",
    fontWeight: 600,
    margin: "24px 0 0",
    padding: "13px 24px",
    textAlign: "center" as const,
    textDecoration: "none",
  } as CSSProperties,

  footerText: {
    color: colors.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "20px 0 0",
  } as CSSProperties,

  footerLink: {
    color: colors.muted,
    fontFamily: mono,
    fontSize: "11px",
    lineHeight: "16px",
    textDecoration: "underline",
    wordBreak: "break-all" as const,
  } as CSSProperties,
};
