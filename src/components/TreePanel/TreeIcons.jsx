const SVG = ({ children }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ display: 'block', flexShrink: 0 }}
  >
    {children}
  </svg>
);

export function IconFolderClosed() {
  return (
    <SVG>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </SVG>
  );
}

export function IconFolderOpen() {
  return (
    <SVG>
      <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
      <circle cx="14" cy="15" r="1" />
    </SVG>
  );
}

export function IconStory() {
  return (
    <SVG>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </SVG>
  );
}

export function IconArchive() {
  return (
    <SVG>
      <path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M8 12v-1" />
      <path d="M8 18v-2" />
      <path d="M8 7V6" />
      <circle cx="8" cy="20" r="2" />
    </SVG>
  );
}

export function IconHouse() {
  return (
    <SVG>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </SVG>
  );
}

export function IconMoon() {
  return (
    <SVG>
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
    </SVG>
  );
}

export function IconStop() {
  return (
    <SVG>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </SVG>
  );
}

export function IconFolderPlus() {
  return (
    <SVG>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </SVG>
  );
}

export function IconImport() {
  return (
    <SVG>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </SVG>
  );
}

export function IconPlay() {
  return (
    <SVG>
      <polygon points="6 3 20 12 6 21 6 3" />
    </SVG>
  );
}

export function IconPen() {
  return (
    <SVG>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </SVG>
  );
}

export function IconArrowUpLeft() {
  return (
    <SVG>
      <path d="M7 7h10v10" />
      <path d="M17 7 7 17" />
    </SVG>
  );
}

export function IconCopy() {
  return (
    <SVG>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </SVG>
  );
}

export function IconScissors() {
  return (
    <SVG>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </SVG>
  );
}

export function IconClipboardPaste() {
  return (
    <SVG>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      <path d="M8 4H6a2 2 0 0 0-2 2v7" />
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <path d="M8 18h7" />
      <path d="m12 14 4 4-4 4" />
    </SVG>
  );
}

export function IconTrash() {
  return (
    <SVG>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </SVG>
  );
}

export function IconReturn() {
  return (
    <SVG>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </SVG>
  );
}

export function IconSquareFilled() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14" height="14" viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

export function IconDiamond() {
  return (
    <SVG>
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />
    </SVG>
  );
}

export function IconArrowRight() {
  return (
    <SVG>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </SVG>
  );
}

// Lookup map keyed by string identifier (safe for memo comparison)
export const ICON_BY_KEY = {
  moon: IconMoon,
  stop: IconStop,
};
