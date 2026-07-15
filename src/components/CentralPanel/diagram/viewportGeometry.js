import { WHEEL_ZOOM_SENSITIVITY, clampZoom } from '../flowDiagramLayout.js';

const TRACKPAD_ZOOM_SENSITIVITY = 0.004;
const PINCH_ZOOM_SENSITIVITY = 0.012;
const MAX_WHEEL_DELTA = 240;
const LINE_HEIGHT_PX = 16;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function getWheelZoomFactor(event, viewportHeight = 800) {
  let delta = Number(event?.deltaY);
  // Certains pilotes de pavé tactile Windows exposent le pincement synthétique
  // sur l'axe X, ou encore via l'ancien wheelDelta alors que deltaY reste nul.
  if ((!Number.isFinite(delta) || delta === 0) && event?.ctrlKey) {
    delta = Number(event?.deltaX);
  }
  if (!Number.isFinite(delta) || delta === 0) {
    const legacyDelta = Number(event?.wheelDeltaY ?? event?.wheelDelta);
    if (Number.isFinite(legacyDelta) && legacyDelta !== 0) delta = -legacyDelta;
  }
  if (!Number.isFinite(delta) || delta === 0) return 1;

  if (event?.deltaMode === 1) delta *= LINE_HEIGHT_PX;
  else if (event?.deltaMode === 2) delta *= finitePositive(viewportHeight) || 800;

  delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));
  const sensitivity = event?.ctrlKey
    ? PINCH_ZOOM_SENSITIVITY
    : Math.abs(delta) <= 40
      ? TRACKPAD_ZOOM_SENSITIVITY
      : WHEEL_ZOOM_SENSITIVITY;
  return Math.exp(-delta * sensitivity);
}

export function fitDiagramViewport({
  containerWidth,
  containerHeight,
  layoutWidth,
  layoutHeight,
  maxZoom = 1,
  horizontalPadding = 64,
  verticalPadding = 96,
}) {
  const width = finitePositive(containerWidth);
  const height = finitePositive(containerHeight);
  const contentWidth = finitePositive(layoutWidth);
  const contentHeight = finitePositive(layoutHeight);
  if (!width || !height || !contentWidth || !contentHeight) return null;

  const availableWidth = Math.max(1, width - horizontalPadding);
  const availableHeight = Math.max(1, height - verticalPadding);
  const zoom = clampZoom(Math.min(
    finitePositive(maxZoom) || 1,
    availableWidth / contentWidth,
    availableHeight / contentHeight,
  ));
  const freeX = width - (contentWidth * zoom);
  const freeY = height - (contentHeight * zoom);

  return {
    zoom,
    camera: {
      x: Math.round(freeX / 2),
      y: freeY >= 0 ? Math.round(Math.max(32, freeY / 6)) : 24,
    },
  };
}

export function preserveViewportCenter(camera, previousSize, nextSize) {
  const previousWidth = finitePositive(previousSize?.width);
  const previousHeight = finitePositive(previousSize?.height);
  const nextWidth = finitePositive(nextSize?.width);
  const nextHeight = finitePositive(nextSize?.height);
  if (!previousWidth || !previousHeight || !nextWidth || !nextHeight) return camera;
  return {
    x: camera.x + ((nextWidth - previousWidth) / 2),
    y: camera.y + ((nextHeight - previousHeight) / 2),
  };
}

export function centerDiagramNode({ containerWidth, containerHeight, zoom, node }) {
  const width = finitePositive(containerWidth);
  const height = finitePositive(containerHeight);
  const currentZoom = finitePositive(zoom);
  const nodeWidth = finitePositive(node?.width);
  const nodeHeight = finitePositive(node?.height);
  const nodeX = Number(node?.x);
  const nodeY = Number(node?.y);
  if (!width || !height || !currentZoom || !nodeWidth || !nodeHeight
    || !Number.isFinite(nodeX) || !Number.isFinite(nodeY)) return null;

  return {
    x: Math.round((width / 2) - ((nodeX + (nodeWidth / 2)) * currentZoom)),
    y: Math.round((height / 2) - ((nodeY + (nodeHeight / 2)) * currentZoom)),
  };
}

export function getDiagramViewportLayoutKey(layout, context = {}) {
  const nodes = (layout?.nodes ?? []).map((node) => [
    node.entry?.id,
    Math.round(node.x),
    Math.round(node.y),
    Math.round(node.width),
    Math.round(node.height),
  ].join(':')).join('|');
  const collapsedIds = [...(context.collapsedIds ?? [])].sort().join(',');
  return [
    context.compactMode ?? '',
    context.focusMode ? `focus:${context.selectedId ?? ''}` : 'all',
    `collapsed:${collapsedIds}`,
    `stories:${context.expandedStoryGroupId ?? ''}`,
    `${Math.round(layout?.width ?? 0)}x${Math.round(layout?.height ?? 0)}`,
    nodes,
  ].join(';');
}
