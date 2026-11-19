/** Una gota de tinta sobre una hoja de cuaderno (renglones azules y margen rojo). */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--logo-paper)" stroke="var(--logo-edge)" strokeWidth="1.5" />
      <path d="M2 43h60M2 52h60" stroke="var(--rule)" strokeWidth="1.6" />
      <path d="M15 2v60" stroke="var(--margin)" strokeWidth="1.6" />
      <path d="M38 11c0 0-12.5 15.6-12.5 23.6a12.5 12.5 0 0 0 25 0C50.5 26.6 38 11 38 11z" fill="var(--ink)" />
      <path d="M33.2 33.5c.2 3.4 2 5.6 4.8 6.6" stroke="var(--logo-paper)" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".55" />
    </svg>
  );
}
