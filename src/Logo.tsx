/** The Marq mark (M↓), in currentColor. Source: assets/logo-mark.svg. */
export function LogoMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="90 93 336 336" aria-hidden="true">
      <path d="M122 330 V130 L232 246 L342 130 V392 M290 340 L342 392 L394 340"
        fill="none" stroke="currentColor" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
