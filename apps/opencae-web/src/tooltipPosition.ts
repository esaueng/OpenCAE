export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipPositionInput {
  triggerRect: RectLike;
  viewport: ViewportSize;
  tooltip: TooltipSize;
  gap?: number;
  margin?: number;
}

export interface TooltipPosition {
  top: number;
  left: number;
}

export function getViewportTooltipPosition({
  triggerRect,
  viewport,
  tooltip,
  gap = 8,
  margin = 12
}: TooltipPositionInput): TooltipPosition {
  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  const preferredLeft = triggerRect.right - tooltip.width;
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft);

  const topAbove = triggerRect.top - tooltip.height - gap;
  const topBelow = triggerRect.bottom + gap;
  const fitsAbove = topAbove >= margin;
  const preferredTop = fitsAbove ? topAbove : topBelow;
  const maxTop = Math.max(margin, viewport.height - tooltip.height - margin);
  const top = Math.min(Math.max(preferredTop, margin), maxTop);

  return { top, left };
}
