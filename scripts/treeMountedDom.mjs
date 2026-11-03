// DOM minimal pour exécuter le vrai reconciler React en Node ; aucune logique produit.
class Node {
  constructor(type, name, document) { this.nodeType = type; this.nodeName = name; this.ownerDocument = document; this.parentNode = null; this.childNodes = []; this.listeners = new Map(); }
  appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) { if (!before) return this.appendChild(node); if (node.parentNode) node.parentNode.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this; return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (value) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
  addEventListener(type, callback, capture) { const list = this.listeners.get(type) ?? []; list.push({ callback, capture: capture === true }); this.listeners.set(type, list); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(x => x.callback !== callback)); }
  dispatchEvent(event) { event.target = this; for (let node = this; node; node = node.parentNode) { event.currentTarget = node; for (const listener of node.listeners.get(event.type) ?? []) if (!listener.capture) listener.callback(event); if (event.cancelBubble) break; } return !event.defaultPrevented; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
}
class Element extends Node {
  constructor(name, document) { super(1, name.toUpperCase(), document); this.tagName = this.nodeName; this.localName = name; this.namespaceURI = 'http://www.w3.org/1999/xhtml'; this.attributes = {}; this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }; this.value = ''; this.disabled = false; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 100, height: 100 }; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  querySelectorAll(selector) { const matches = []; const visit = n => { if (n.nodeType === 1 && (selector === '*' || selector === n.localName || selector.startsWith('.') && (n.attributes.class ?? '').split(' ').includes(selector.slice(1)) || selector.startsWith('#') && n.attributes.id === selector.slice(1))) matches.push(n); n.childNodes.forEach(visit); }; this.childNodes.forEach(visit); return matches; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
class Document extends Node {
  constructor() { super(9, '#document', null); this.ownerDocument = this; this.documentElement = new Element('html', this); this.body = new Element('body', this); this.appendChild(this.documentElement); this.documentElement.appendChild(this.body); this.activeElement = this.body; }
  createElement(name) { return new Element(name, this); }
  createElementNS(_namespace, name) { return new Element(name, this); }
  createTextNode(text) { const node = new Node(3, '#text', this); node.nodeValue = String(text); return node; }
}
export function installMountedDom() {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const document = new Document(); const window = { document, Node, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, HTMLElement: Element, HTMLIFrameElement: class extends Element {}, addEventListener() {}, removeEventListener() {}, getComputedStyle() { return {}; } }; document.defaultView = window;
  globalThis.document = document; globalThis.window = window; globalThis.HTMLElement = Element; globalThis.Node = Node; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { document, restore() { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}
export function click(node) { node.dispatchEvent({ type: 'click', button: 0, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } }); }
export function renderedText(root) { return root.textContent + root.querySelectorAll('*').map(n => ['title', 'aria-label', 'alt', 'placeholder'].map(k => n.getAttribute(k) ?? '').join(' ')).join(' '); }
