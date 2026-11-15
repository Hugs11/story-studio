// Positions in the scroll container's coordinates, in document order.
// Match the cards' 16px scroll-margin-top when navigating from the summary.
export function activeOptionsSection(sections, scrollTop, viewportHeight, scrollHeight, navigationTarget = null) {
  if (navigationTarget) return navigationTarget;
  const max = scrollHeight - viewportHeight;
  // With no scrolling, keep the first section (unless explicitly navigated to).
  if (max <= 0) return sections[0]?.id;
  const remaining = max - scrollTop;
  // Move the activation line down over the last viewport so short final cards
  // are visited in order, without a special jump at the bottom.
  const line = 16 + (viewportHeight - 16) * Math.max(0, 1 - remaining / viewportHeight);
  let activeId = sections[0]?.id;
  for (const section of sections) {
    if (section.top > scrollTop + line + 1) break;
    activeId = section.id;
  }
  return activeId;
}
