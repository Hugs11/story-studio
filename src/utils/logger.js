import { isTauriRuntime } from './tauriRuntime';

const isDev = import.meta.env.DEV;

// Frontend log event names should use the `module:action` convention.
const LEVEL_RANK = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
let currentLevel = LEVEL_RANK.warn;

export function setLogLevel(level) {
  const rank = LEVEL_RANK[String(level || '').toLowerCase()];
  if (typeof rank === 'number') currentLevel = rank;
}

export function getLogLevel() {
  return Object.keys(LEVEL_RANK).find((key) => LEVEL_RANK[key] === currentLevel) || 'warn';
}

let pluginLogPromise = null;
async function getPluginLog() {
  if (!isTauriRuntime()) return null;
  if (!pluginLogPromise) {
    pluginLogPromise = import('@tauri-apps/plugin-log').catch((err) => {
      // reason: fallback console quand le plugin Tauri est absent (mode web / dev hors Tauri) ;
      // c'est notre seul recours puisque logger lui-meme ne peut pas se reappeler ici.
      // eslint-disable-next-line no-console
      console.warn('logger:plugin-unavailable', err);
      return null;
    });
  }
  return pluginLogPromise;
}

function stringify(args) {
  return args
    .map((value) => {
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); }
      catch { return String(value); }
    })
    .join(' ');
}

function forward(method, args) {
  const required = LEVEL_RANK[method] ?? LEVEL_RANK.error;
  if (required > currentLevel) return;
  if (isDev) console[method === 'info' ? 'info' : method === 'warn' ? 'warn' : 'error'](...args);
  const payload = stringify(args);
  getPluginLog().then((mod) => {
    if (!mod) return;
    const fn = mod[method];
    if (typeof fn === 'function') fn(payload).catch(() => {});
  });
}

export const logger = {
  error: (...args) => forward('error', args),
  warn: (...args) => forward('warn', args),
  info: (...args) => forward('info', args),
};

export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return () => {};
  function onError(event) {
    const location = `${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}`;
    if (event.error?.stack) logger.error(`runtime:uncaught-error location=${location} stack=${event.error.stack}`);
    else logger.error(`runtime:uncaught-error location=${location} message=${event.message}`);
  }
  function onRejection(event) {
    const reason = event.reason;
    if (reason?.stack) logger.error(`runtime:unhandled-rejection stack=${reason.stack}`);
    else logger.error(`runtime:unhandled-rejection reason=${stringify([reason])}`);
  }
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
