export function OpenFeaLogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <img className={className} src="/openfea-logo.png" alt={title ?? ""} aria-hidden={title ? undefined : true} />
  );
}
