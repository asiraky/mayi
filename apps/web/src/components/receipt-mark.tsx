/**
 * The receipt mark: a perforated slip with the approver's tick. Same geometry as the
 * marketing site's ReceiptMark.astro and public/favicon.svg — symmetric about x=14.
 *
 * The slip draws with currentColor so it follows the surrounding ink; the check stays
 * --primary in BOTH schemes — same rule as the pending dot: the brand blue is a
 * graphic fill here, not text, so it does not flip with the theme.
 */
export function ReceiptMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <path
        d="M7 3.5H21V21.5L19.25 24L17.5 21.5L15.75 24L14 21.5L12.25 24L10.5 21.5L8.75 24L7 21.5Z"
        className="stroke-current"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M9.75 12.75L12.75 15.75L18.25 9.25"
        className="stroke-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
