export function OpenCaeLogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <img className={className} src="/opencae-logo.png" alt={title ?? ""} aria-hidden={title ? undefined : true} />
  );
}
