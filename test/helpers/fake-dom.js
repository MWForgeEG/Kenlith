'use strict';

// The small part of the DOM that src/markdown.js uses, so its renderer can be
// tested under Node. It records exactly which elements and attributes were
// created; serialize() escapes all text, as the browser's own serializer does.

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.nodeType === 11) {
        const children = node.childNodes;
        node.childNodes = [];
        this.append(...children);
      } else {
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.localName = tag;
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  get textContent() {
    return super.textContent;
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '') this.append(new FakeText(this.ownerDocument, value));
  }
}

class FakeFragment extends FakeNode {
  constructor(doc) {
    super(doc);
    this.nodeType = 11;
  }
}

function createDocument() {
  const doc = {
    createElement(tag) {
      if (!/^[a-z][a-z0-9]*$/.test(tag)) throw new Error(`bad tag ${tag}`);
      return new FakeElement(doc, tag);
    },
    createTextNode: (data) => new FakeText(doc, data),
    createDocumentFragment: () => new FakeFragment(doc)
  };
  return doc;
}

const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text) => escapeText(text).replace(/"/g, '&quot;');
const VOID = new Set(['br', 'hr']);

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  const inner = node.childNodes.map(serialize).join('');
  if (node.nodeType === 11) return inner;
  const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attributes}>`;
  return `<${node.localName}${attributes}>${inner}</${node.localName}>`;
}

function elements(node, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      out.push(child);
      elements(child, out);
    }
  }
  return out;
}

module.exports = { createDocument, serialize, elements };
