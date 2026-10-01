/**
 * Streaming XML item extractor (ADR-0018 §Streaming parse).
 *
 * Wraps `saxes` (strict, non-validating, no DTD processing — only the five
 * predefined XML entities resolve) and turns parser events into one
 * {@link RawFeedItem} per mapped item element. It is the *extraction* layer
 * only: the byte-level UTF-8 gate, the streaming DOCTYPE/ENTITY scanner and
 * the archive integrity check run before any text reaches it (see
 * verified-archive.ts), and normalization happens afterwards (normalize/).
 *
 * Memory is bounded independently of feed size:
 *   - only paths referenced by the mapping are captured;
 *   - each captured field stops growing at `maxFieldChars + 1` characters
 *     (the overflow is recorded, never the extra text);
 *   - per-item element/attribute counts and document depth are capped;
 *   - items are handed to the caller as they close and are not retained.
 */

import { SaxesParser, type SaxesTagPlain } from 'saxes';

import { XmlSecurityError } from '../parser/xml-security.js';

import { mappingPaths, type FeedItemMapping } from './mapping.js';

export interface XmlItemLimits {
  readonly maxItems: number;
  readonly maxFieldChars: number;
  readonly maxDepth: number;
  readonly maxElementsPerItem: number;
  readonly maxAttributesPerElement: number;
}

export type RawItemDefect = 'ITEM_TOO_MANY_ELEMENTS' | 'ITEM_TOO_MANY_ATTRIBUTES';

export interface RawFeedItem {
  /** 0-based ordinal of the item within the document. */
  readonly index: number;
  /** path → captured text (first non-empty occurrence wins). */
  readonly values: ReadonlyMap<string, string>;
  /** Paths whose captured text exceeded `maxFieldChars`. */
  readonly oversize: ReadonlySet<string>;
  /** Structural defect that makes the item unusable, if any. */
  readonly defect: RawItemDefect | null;
}

export type XmlDocumentErrorCode =
  | 'XML_MALFORMED'
  | 'XML_TOO_DEEP'
  | 'TOO_MANY_ITEMS';

/** A document-level failure: the whole import fails (no deactivation). */
export class XmlDocumentError extends Error {
  constructor(
    public readonly code: XmlDocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XmlDocumentError';
  }
}

/** Mapping paths have at most this many segments (see mapping.ts). */
const MAX_PATH_SEGMENTS = 4;

interface OpenItem {
  index: number;
  depth: number;
  elements: number;
  defect: RawItemDefect | null;
  values: Map<string, string>;
  oversize: Set<string>;
}

export class XmlItemExtractor {
  private readonly parser = new SaxesParser<{ xmlns: false; position: true }>({
    xmlns: false,
    position: true,
  });
  private readonly elementPaths: ReadonlySet<string>;
  private readonly attributePaths: ReadonlySet<string>;

  private depth = 0;
  private item: OpenItem | null = null;
  /** Element names below the item element (item element itself excluded). */
  private readonly rel: string[] = [];
  /** For each open element inside the item: its capture frame, or null. */
  private readonly captureStack: Array<{ path: string; text: string } | null> = [];
  private itemCount = 0;
  private closed = false;

  constructor(
    private readonly mapping: FeedItemMapping,
    private readonly limits: XmlItemLimits,
    private readonly onItem: (item: RawFeedItem) => void,
  ) {
    const elements = new Set<string>();
    const attributes = new Set<string>();
    for (const p of mappingPaths(mapping)) {
      (p.split('/').pop()!.startsWith('@') ? attributes : elements).add(p);
    }
    this.elementPaths = elements;
    this.attributePaths = attributes;

    // DTDs are already rejected byte-wise before parsing; refuse here too so
    // the extractor is safe even if called on unscanned input.
    this.parser.on('doctype', () => {
      throw new XmlSecurityError('XML_DOCTYPE_REJECTED', 'DOCTYPE declaration is not permitted');
    });
    this.parser.on('opentag', (tag) => this.onOpen(tag));
    this.parser.on('closetag', () => this.onClose());
    this.parser.on('text', (t) => this.onText(t));
    this.parser.on('cdata', (t) => this.onText(t));
  }

  /** Items seen so far (including rejected ones). */
  get itemsSeen(): number {
    return this.itemCount;
  }

  /** Feed decoded text. Throws XmlDocumentError / XmlSecurityError. */
  write(text: string): void {
    if (this.closed) throw new Error('XmlItemExtractor: write after close');
    try {
      this.parser.write(text);
    } catch (err) {
      throw translate(err);
    }
  }

  /** Signal end of document; throws if the document is incomplete. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.parser.close();
    } catch (err) {
      throw translate(err);
    }
  }

  // -------------------------------------------------------------------------

  private onOpen(tag: SaxesTagPlain): void {
    this.depth += 1;
    if (this.depth > this.limits.maxDepth) {
      throw new XmlDocumentError('XML_TOO_DEEP', `nesting exceeds ${this.limits.maxDepth}`);
    }

    if (this.item === null) {
      if (tag.name !== this.mapping.itemElement) return;
      this.itemCount += 1;
      if (this.itemCount > this.limits.maxItems) {
        throw new XmlDocumentError('TOO_MANY_ITEMS', `more than ${this.limits.maxItems} items`);
      }
      this.item = {
        index: this.itemCount - 1,
        depth: this.depth,
        elements: 0,
        defect: null,
        values: new Map(),
        oversize: new Set(),
      };
      this.captureAttributes('', tag);
      return;
    }

    const item = this.item;
    item.elements += 1;
    if (item.elements > this.limits.maxElementsPerItem) item.defect ??= 'ITEM_TOO_MANY_ELEMENTS';

    this.rel.push(tag.name);
    const path = this.rel.length <= MAX_PATH_SEGMENTS ? this.rel.join('/') : null;
    const capture = item.defect === null && path !== null && this.elementPaths.has(path);
    this.captureStack.push(capture ? { path: path!, text: '' } : null);
    if (path !== null && item.defect === null) this.captureAttributes(path, tag);
  }

  private onClose(): void {
    this.depth -= 1;
    const item = this.item;
    if (item === null) return;

    if (this.depth + 1 === item.depth) {
      // Closing the item element itself.
      this.item = null;
      this.onItem({
        index: item.index,
        values: item.values,
        oversize: item.oversize,
        defect: item.defect,
      });
      return;
    }

    const frame = this.captureStack.pop() ?? null;
    this.rel.pop();
    if (frame !== null) this.store(item, frame.path, frame.text);
  }

  private onText(text: string): void {
    if (this.item === null) return;
    // Direct text of the innermost open element only.
    const frame = this.captureStack[this.captureStack.length - 1];
    if (!frame) return;
    const room = this.limits.maxFieldChars + 1 - frame.text.length;
    if (room > 0) frame.text += text.length > room ? text.slice(0, room) : text;
  }

  private captureAttributes(prefix: string, tag: SaxesTagPlain): void {
    const item = this.item!;
    const names = Object.keys(tag.attributes);
    if (names.length > this.limits.maxAttributesPerElement) {
      item.defect ??= 'ITEM_TOO_MANY_ATTRIBUTES';
      return;
    }
    if (this.attributePaths.size === 0) return;
    for (const name of names) {
      const path = prefix === '' ? `@${name}` : `${prefix}/@${name}`;
      if (this.attributePaths.has(path)) this.store(item, path, tag.attributes[name] ?? '');
    }
  }

  private store(item: OpenItem, path: string, raw: string): void {
    if (raw.trim().length === 0) return;
    if (item.values.has(path)) return; // first non-empty occurrence wins
    if (raw.length > this.limits.maxFieldChars) {
      item.oversize.add(path);
      item.values.set(path, raw.slice(0, this.limits.maxFieldChars));
      return;
    }
    item.values.set(path, raw);
  }
}

function translate(err: unknown): Error {
  if (err instanceof XmlDocumentError || err instanceof XmlSecurityError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // saxes errors carry "line:column: reason" — no document content.
  return new XmlDocumentError('XML_MALFORMED', message.slice(0, 200));
}
