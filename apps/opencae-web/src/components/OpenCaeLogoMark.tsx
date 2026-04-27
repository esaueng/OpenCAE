export function OpenCaeLogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="opencae-logo-bg" x1="10" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#111c33" />
          <stop offset="1" stopColor="#06101d" />
        </linearGradient>
        <linearGradient id="opencae-logo-stress" x1="13" y1="51" x2="50" y2="10" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1668ff" />
          <stop offset="0.5" stopColor="#23d18b" />
          <stop offset="1" stopColor="#ff9f1a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="13" fill="url(#opencae-logo-bg)" />
      <path d="M14 49h37v-9h-8.5l-5-11.5L47 18h-9.5L28 29.5 21 49h-7Z" fill="url(#opencae-logo-stress)" stroke="#8ff3ff" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="44.5" cy="18.5" r="5.5" fill="#07111f" stroke="#ffba38" strokeWidth="3" />
      <path d="M27 38.5 34.5 30 39 40H28.5Z" fill="#07111f" opacity="0.9" />
      <circle cx="22" cy="48" r="3.2" fill="#07111f" stroke="#5aa2ff" strokeWidth="2.2" />
      <circle cx="47" cy="48" r="3.2" fill="#07111f" stroke="#54e6b2" strokeWidth="2.2" />
      <path d="M17 49h34M31 25l-6.5 24M39 23l5.5 26" fill="none" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
