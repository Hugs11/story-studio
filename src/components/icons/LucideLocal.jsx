import { createElement } from 'react';

const DEFAULT_ATTRS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

function renderNode(node, index) {
  const [tag, attrs] = node;
  const elementAttrs = { ...attrs };
  delete elementAttrs.key;
  return createElement(tag, { key: attrs.key ?? `${tag}-${index}`, ...DEFAULT_ATTRS, ...elementAttrs });
}

function LocalIcon({
  className,
  strokeWidth = 2,
  absoluteStrokeWidth = false,
  children,
  ...props
}) {
  const computedStrokeWidth = absoluteStrokeWidth ? strokeWidth * 24 / 24 : strokeWidth;

  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={computedStrokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {children.map(renderNode)}
    </svg>
  );
}

function createLocalLucideIcon(iconNode) {
  return function Icon(props) {
    return <LocalIcon {...props}>{iconNode}</LocalIcon>;
  };
}

const filePenNode = [
  ['path', { d: 'M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34' }],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
  ['path', { d: 'M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z' }],
];

const kanbanNode = [
  ['path', { d: 'M5 3v14' }],
  ['path', { d: 'M12 3v8' }],
  ['path', { d: 'M19 3v18' }],
];

const panelLeftNode = [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
  ['path', { d: 'M9 3v18' }],
];

const monitorPlayNode = [
  ['path', { d: 'M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z' }],
  ['path', { d: 'M12 17v4' }],
  ['path', { d: 'M8 21h8' }],
  ['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }],
];

const micNode = [
  ['path', { d: 'M12 19a7 7 0 0 0 7-7v-2' }],
  ['path', { d: 'M5 10v2a7 7 0 0 0 7 7' }],
  ['rect', { x: '9', y: '2', width: '6', height: '11', rx: '3' }],
  ['path', { d: 'M12 19v3' }],
  ['path', { d: 'M8 22h8' }],
];

const networkNode = [
  ['rect', { x: '16', y: '16', width: '6', height: '6', rx: '1' }],
  ['rect', { x: '2', y: '16', width: '6', height: '6', rx: '1' }],
  ['rect', { x: '9', y: '2', width: '6', height: '6', rx: '1' }],
  ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }],
  ['path', { d: 'M12 12V8' }],
];

const wrenchNode = [
  ['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z' }],
];

const filePlusNode = [
  ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
  ['path', { d: 'M9 15h6' }],
  ['path', { d: 'M12 18v-6' }],
];

const folderOpenNode = [
  ['path', { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' }],
];

const saveNode = [
  ['path', { d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }],
  ['path', { d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7' }],
  ['path', { d: 'M7 3v4a1 1 0 0 0 1 1h7' }],
];

const downloadNode = [
  ['path', { d: 'M12 15V3' }],
  ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
  ['path', { d: 'm7 10 5 5 5-5' }],
];

const folderPlusNode = [
  ['path', { d: 'M12 10v6' }],
  ['path', { d: 'M9 13h6' }],
  ['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }],
];

const packageNode = [
  ['path', { d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' }],
  ['path', { d: 'M12 22V12' }],
  ['polyline', { points: '3.29 7 12 12 20.71 7' }],
  ['path', { d: 'm7.5 4.27 9 5.15' }],
];

const slidersHorizontalNode = [
  ['path', { d: 'M10 5H3' }],
  ['path', { d: 'M12 19H3' }],
  ['path', { d: 'M14 3v4' }],
  ['path', { d: 'M16 17v4' }],
  ['path', { d: 'M21 12h-9' }],
  ['path', { d: 'M21 19h-5' }],
  ['path', { d: 'M21 5h-7' }],
  ['path', { d: 'M8 10v4' }],
  ['path', { d: 'M8 12H3' }],
];

const listTodoNode = [
  ['path', { d: 'M13 5h8' }],
  ['path', { d: 'M13 12h8' }],
  ['path', { d: 'M13 19h8' }],
  ['path', { d: 'm3 17 2 2 4-4' }],
  ['rect', { x: '3', y: '4', width: '6', height: '6', rx: '1' }],
];

const swatchBookNode = [
  ['path', { d: 'M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z' }],
  ['path', { d: 'M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7' }],
  ['path', { d: 'M7 17h.01' }],
  ['path', { d: 'm11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8' }],
];

const playNode = [
  ['polygon', { points: '6 3 20 12 6 21 6 3' }],
];

const pauseNode = [
  ['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }],
  ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }],
];

const circleStopNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1' }],
];

const squareNode = [
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
];

const skipBackNode = [
  ['polygon', { points: '19 20 9 12 19 4 19 20' }],
  ['line', { x1: '5', y1: '19', x2: '5', y2: '5' }],
];

const skipForwardNode = [
  ['polygon', { points: '5 4 15 12 5 20 5 4' }],
  ['line', { x1: '19', y1: '5', x2: '19', y2: '19' }],
];

const scissorsNode = [
  ['circle', { cx: '6', cy: '6', r: '3' }],
  ['path', { d: 'M8.12 8.12 12 12' }],
  ['path', { d: 'M20 4 8.12 15.88' }],
  ['circle', { cx: '6', cy: '18', r: '3' }],
  ['path', { d: 'M14.8 14.8 20 20' }],
];

const cropNode = [
  ['path', { d: 'M6 2v14a2 2 0 0 0 2 2h14' }],
  ['path', { d: 'M18 22V8a2 2 0 0 0-2-2H2' }],
];

const rotateCcwNode = [
  ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
  ['path', { d: 'M3 3v5h5' }],
];

const chevronRightNode = [
  ['path', { d: 'm9 18 6-6-6-6' }],
];

const chevronDownNode = [
  ['path', { d: 'm6 9 6 6 6-6' }],
];

const chevronUpNode = [
  ['path', { d: 'm18 15-6-6-6 6' }],
];

const moveUpNode = [
  ['path', { d: 'M8 6 12 2 16 6' }],
  ['path', { d: 'M12 2v20' }],
];

const moveDownNode = [
  ['path', { d: 'M8 18 12 22 16 18' }],
  ['path', { d: 'M12 2v20' }],
];

const undo2Node = [
  ['path', { d: 'M9 14 4 9l5-5' }],
  ['path', { d: 'M4 9h10.5a5.5 5.5 0 1 1 0 11H11' }],
];

const copyNode = [
  ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
  ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
];

const clipboardPasteNode = [
  ['path', { d: 'M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z' }],
  ['path', { d: 'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4' }],
  ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v2' }],
  ['path', { d: 'M11 14h10' }],
  ['path', { d: 'm17 10 4 4-4 4' }],
];

const trash2Node = [
  ['path', { d: 'M3 6h18' }],
  ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
  ['path', { d: 'M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
  ['path', { d: 'M10 11v6' }],
  ['path', { d: 'M14 11v6' }],
];

const musicNode = [
  ['path', { d: 'M9 18V5l12-2v13' }],
  ['circle', { cx: '6', cy: '18', r: '3' }],
  ['circle', { cx: '18', cy: '16', r: '3' }],
];

const imageNode = [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }],
  ['circle', { cx: '9', cy: '9', r: '2' }],
  ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }],
];

const moonNode = [
  ['path', { d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' }],
];

const houseNode = [
  ['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }],
  ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
];

const folderInputNode = [
  ['path', { d: 'M2 9V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2' }],
  ['path', { d: 'M2 13h10' }],
  ['path', { d: 'm9 16 3-3-3-3' }],
];

const sparklesNode = [
  ['path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }],
  ['path', { d: 'M20 3v4' }],
  ['path', { d: 'M22 5h-4' }],
  ['path', { d: 'M4 17v2' }],
  ['path', { d: 'M5 18H3' }],
];

const dicesNode = [
  ['rect', { width: '12', height: '12', x: '2', y: '10', rx: '2', ry: '2' }],
  ['path', { d: 'm17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6' }],
  ['path', { d: 'M6 18h.01' }],
  ['path', { d: 'M10 14h.01' }],
  ['path', { d: 'M15 6h.01' }],
  ['path', { d: 'M18 9h.01' }],
];

const eyeNode = [
  ['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }],
  ['circle', { cx: '12', cy: '12', r: '3' }],
];

const link2Node = [
  ['path', { d: 'M9 17H7A5 5 0 0 1 7 7h2' }],
  ['path', { d: 'M15 7h2a5 5 0 1 1 0 10h-2' }],
  ['line', { x1: '8', x2: '16', y1: '12', y2: '12' }],
];

const loader2Node = [
  ['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }],
];

const circleCheckNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'm9 12 2 2 4-4' }],
];

const circleXNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'm15 9-6 6' }],
  ['path', { d: 'm9 9 6 6' }],
];

const checkNode = [
  ['path', { d: 'M20 6 9 17l-5-5' }],
];

const xNode = [
  ['path', { d: 'M18 6 6 18' }],
  ['path', { d: 'm6 6 12 12' }],
];

const triangleAlertNode = [
  ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
  ['path', { d: 'M12 9v4' }],
  ['path', { d: 'M12 17h.01' }],
];

const settingsNode = [
  ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
  ['circle', { cx: '12', cy: '12', r: '3' }],
];

const speechNode = [
  ['path', { d: 'M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.77 5.77 0 0 1 .029 2.758L2 20' }],
  ['path', { d: 'M19.8 17.8a7.5 7.5 0 0 0 .003-10.603' }],
  ['path', { d: 'M17 15a3.5 3.5 0 0 0-.025-4.975' }],
];

const infoNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M12 16v-4' }],
  ['path', { d: 'M12 8h.01' }],
];

const searchNode = [
  ['circle', { cx: '11', cy: '11', r: '8' }],
  ['path', { d: 'm21 21-4.3-4.3' }],
];

export const FilePen = createLocalLucideIcon(filePenNode);
export const Kanban = createLocalLucideIcon(kanbanNode);
export const PanelLeft = createLocalLucideIcon(panelLeftNode);
export const Mic = createLocalLucideIcon(micNode);
export const MonitorPlay = createLocalLucideIcon(monitorPlayNode);
export const Network = createLocalLucideIcon(networkNode);
export const Wrench = createLocalLucideIcon(wrenchNode);
export const FilePlus = createLocalLucideIcon(filePlusNode);
export const FolderOpen = createLocalLucideIcon(folderOpenNode);
export const Save = createLocalLucideIcon(saveNode);
export const Download = createLocalLucideIcon(downloadNode);
export const FolderPlus = createLocalLucideIcon(folderPlusNode);
export const Package = createLocalLucideIcon(packageNode);
export const SlidersHorizontal = createLocalLucideIcon(slidersHorizontalNode);
export const ListTodo = createLocalLucideIcon(listTodoNode);
export const SwatchBook = createLocalLucideIcon(swatchBookNode);
export const Play = createLocalLucideIcon(playNode);
export const Pause = createLocalLucideIcon(pauseNode);
export const CircleStop = createLocalLucideIcon(circleStopNode);
export const Square = createLocalLucideIcon(squareNode);
export const SkipBack = createLocalLucideIcon(skipBackNode);
export const SkipForward = createLocalLucideIcon(skipForwardNode);
export const Scissors = createLocalLucideIcon(scissorsNode);
export const Crop = createLocalLucideIcon(cropNode);
export const RotateCcw = createLocalLucideIcon(rotateCcwNode);
export const ChevronRight = createLocalLucideIcon(chevronRightNode);
export const ChevronDown = createLocalLucideIcon(chevronDownNode);
export const ChevronUp = createLocalLucideIcon(chevronUpNode);
export const MoveUp = createLocalLucideIcon(moveUpNode);
export const MoveDown = createLocalLucideIcon(moveDownNode);
export const Undo2 = createLocalLucideIcon(undo2Node);
export const Copy = createLocalLucideIcon(copyNode);
export const ClipboardPaste = createLocalLucideIcon(clipboardPasteNode);
export const Trash2 = createLocalLucideIcon(trash2Node);
export const Music = createLocalLucideIcon(musicNode);
export const Image = createLocalLucideIcon(imageNode);
export const Moon = createLocalLucideIcon(moonNode);
export const House = createLocalLucideIcon(houseNode);
export const FolderInput = createLocalLucideIcon(folderInputNode);
export const Sparkles = createLocalLucideIcon(sparklesNode);
export const Dices = createLocalLucideIcon(dicesNode);
export const Eye = createLocalLucideIcon(eyeNode);
export const Link2 = createLocalLucideIcon(link2Node);
export const Loader2 = createLocalLucideIcon(loader2Node);
export const CircleCheck = createLocalLucideIcon(circleCheckNode);
export const CircleX = createLocalLucideIcon(circleXNode);
export const Check = createLocalLucideIcon(checkNode);
export const X = createLocalLucideIcon(xNode);
export const TriangleAlert = createLocalLucideIcon(triangleAlertNode);
export const Settings = createLocalLucideIcon(settingsNode);
export const Speech = createLocalLucideIcon(speechNode);
export const Info = createLocalLucideIcon(infoNode);
export const Search = createLocalLucideIcon(searchNode);
