import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildArchiveRef,
  FeedItemMappingSchema,
  GOOGLE_MERCHANT_PRESET,
  ImportError,
  streamVerifiedXmlText,
  verifyArchiveIntegrity,
  XmlDocumentError,
  XmlItemExtractor,
  XmlSecurityError,
  type ExpectedArchive,
  type FeedArchive,
  type FeedItemMapping,
  type RawFeedItem,
  type XmlItemLimits,
} from '../src/modules/feeds/index.js';

const LIMITS: XmlItemLimits = {
  maxItems: 1000,
  maxFieldChars: 1000,
  maxDepth: 32,
  maxElementsPerItem: 100,
  maxAttributesPerElement: 8,
};

const URUN: FeedItemMapping = FeedItemMappingSchema.parse({
  itemElement: 'urun',
  fields: {
    externalId: '@kod',
    title: 'urunadi',
    price: 'fiyatlar/satis',
    url: 'link',
    image: 'resimler/resim/@url',
    description: 'aciklama',
  },
  defaultCurrency: 'TRY',
});

function extract(
  chunks: readonly string[],
  mapping: FeedItemMapping = URUN,
  limits: XmlItemLimits = LIMITS,
): RawFeedItem[] {
  const items: RawFeedItem[] = [];
  const x = new XmlItemExtractor(mapping, limits, (i) => items.push(i));
  for (const c of chunks) x.write(c);
  x.close();
  return items;
}

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<urunler>
  <urun kod="A-1">
    <urunadi>Çaydanlık &amp; Demlik — İnox</urunadi>
    <fiyatlar><satis>1.299,90</satis><eski>1.499,90</eski></fiyatlar>
    <link>https://shop.example.com/a-1</link>
    <resimler><resim url="https://cdn.example.net/a1.jpg"/><resim url="https://cdn.example.net/a1b.jpg"/></resimler>
    <aciklama><![CDATA[<b>Kalın</b> açıklama]]></aciklama>
  </urun>
  <urun kod="B-2">
    <urunadi></urunadi>
    <urunadi>İkinci başlık</urunadi>
    <fiyatlar><satis>49,90</satis></fiyatlar>
    <link>https://shop.example.com/b-2</link>
  </urun>
</urunler>`;

describe('feeds import: XmlItemExtractor', () => {
  it('extracts mapped elements, nested paths, attributes, entities and CDATA', () => {
    const items = extract([DOC]);
    expect(items).toHaveLength(2);
    const [a, b] = items;
    expect(a?.index).toBe(0);
    expect(Object.fromEntries(a!.values)).toEqual({
      '@kod': 'A-1',
      urunadi: 'Çaydanlık & Demlik — İnox',
      'fiyatlar/satis': '1.299,90',
      link: 'https://shop.example.com/a-1',
      'resimler/resim/@url': 'https://cdn.example.net/a1.jpg', // first occurrence wins
      aciklama: '<b>Kalın</b> açıklama',
    });
    // Unmapped elements (fiyatlar/eski) are never captured.
    expect(a!.values.has('fiyatlar/eski')).toBe(false);
    // First NON-EMPTY occurrence wins.
    expect(b!.values.get('urunadi')).toBe('İkinci başlık');
  });

  it('Google Merchant RSS with g: prefix', () => {
    const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Mağaza</title>
<item><g:id>G1</g:id><title>Kulaklık</title><g:price>1299.90 TRY</g:price>
<g:link>https://shop.example.com/g1</g:link><g:availability>in_stock</g:availability></item>
</channel></rss>`;
    const items = extract([rss], GOOGLE_MERCHANT_PRESET);
    expect(items).toHaveLength(1);
    expect(items[0]!.values.get('g:id')).toBe('G1');
    expect(items[0]!.values.get('title')).toBe('Kulaklık');
    expect(items[0]!.values.get('g:price')).toBe('1299.90 TRY');
  });

  it('chunk boundary: every split point yields identical items', () => {
    const whole = extract([DOC]).map((i) => Object.fromEntries(i.values));
    for (let cut = 1; cut < DOC.length; cut += 1) {
      const split = extract([DOC.slice(0, cut), DOC.slice(cut)]).map((i) => Object.fromEntries(i.values));
      expect(split).toEqual(whole);
    }
  });

  it('one character per chunk still works', () => {
    expect(extract([...DOC]).length).toBe(2);
  });

  it('malformed XML → XML_MALFORMED (document-level)', () => {
    expect(() => extract(['<urunler><urun kod="1"><urunadi>x</urun></urunler>'])).toThrow(XmlDocumentError);
    try {
      extract(['<urunler><urun>']);
    } catch (err) {
      expect((err as XmlDocumentError).code).toBe('XML_MALFORMED');
    }
  });

  it('undefined entity is not expanded → XML_MALFORMED', () => {
    expect(() => extract(['<urunler><urun kod="1"><urunadi>&xxe;</urunadi></urun></urunler>'])).toThrow(
      /undefined entity/,
    );
  });

  it('DOCTYPE is rejected by the extractor itself (defense in depth)', () => {
    expect(() =>
      extract(['<!DOCTYPE urunler [<!ENTITY a "aaaa">]><urunler><urun kod="1">&a;</urun></urunler>']),
    ).toThrow(XmlSecurityError);
  });

  it('nesting deeper than maxDepth → XML_TOO_DEEP', () => {
    const deep = '<a>'.repeat(40) + '</a>'.repeat(40);
    expect(() => extract([deep], URUN, { ...LIMITS, maxDepth: 32 })).toThrow(
      expect.objectContaining({ code: 'XML_TOO_DEEP' }),
    );
  });

  it('more than maxItems → TOO_MANY_ITEMS', () => {
    const doc = `<urunler>${'<urun kod="x"/>'.repeat(6)}</urunler>`;
    expect(() => extract([doc], URUN, { ...LIMITS, maxItems: 5 })).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_ITEMS' }),
    );
  });

  it('too many elements / attributes in one item → item defect, not document failure', () => {
    const manyEl = `<urunler><urun kod="1">${'<x/>'.repeat(20)}</urun><urun kod="2"><urunadi>ok</urunadi></urun></urunler>`;
    const items = extract([manyEl], URUN, { ...LIMITS, maxElementsPerItem: 10 });
    expect(items.map((i) => i.defect)).toEqual(['ITEM_TOO_MANY_ELEMENTS', null]);

    const attrs = Array.from({ length: 12 }, (_, i) => `a${i}="v"`).join(' ');
    const manyAttr = `<urunler><urun kod="1"><urunadi ${attrs}>x</urunadi></urun></urunler>`;
    expect(extract([manyAttr])[0]?.defect).toBe('ITEM_TOO_MANY_ATTRIBUTES');
  });

  it('oversized field is capped in memory and flagged', () => {
    const big = 'ğ'.repeat(5000);
    const items = extract([`<urunler><urun kod="1"><aciklama>${big}</aciklama></urun></urunler>`], URUN, {
      ...LIMITS,
      maxFieldChars: 300,
    });
    expect(items[0]!.oversize.has('aciklama')).toBe(true);
    expect(items[0]!.values.get('aciklama')!.length).toBe(300);
  });
});

// ===========================================================================
// Verified archive re-read (UTF-8 gate + security scanner + SHA-256)
// ===========================================================================

class MemoryArchive implements FeedArchive {
  constructor(
    private bytes: Uint8Array,
    private readonly chunkSize = 64,
  ) {}
  replace(bytes: Uint8Array): void {
    this.bytes = bytes;
  }
  async openWriter(): Promise<never> {
    throw new Error('not used');
  }
  async read(): Promise<AsyncIterable<Uint8Array>> {
    const { bytes, chunkSize } = this;
    return (async function* () {
      for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
    })();
  }
  async exists(): Promise<boolean> {
    return true;
  }
  async delete(): Promise<void> {}
}

function expected(bytes: Uint8Array, over: Partial<ExpectedArchive> = {}): ExpectedArchive {
  const tenantId = randomUUID();
  const feedId = randomUUID();
  const fetchId = randomUUID();
  return {
    tenantId,
    feedId,
    fetchId,
    format: 'CUSTOM_XML',
    ref: buildArchiveRef({ tenantId, feedId, fetchId, format: 'CUSTOM_XML' }),
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'application/xml; charset=utf-8',
    maxBytes: 1024 * 1024,
    ...over,
  };
}

async function collect(archive: FeedArchive, e: ExpectedArchive): Promise<string> {
  let out = '';
  await streamVerifiedXmlText(archive, e, (t) => {
    out += t;
  });
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('feeds import: verified archive re-read', () => {
  it('byte-by-byte chunks reassemble multi-byte Turkish text exactly', async () => {
    const bytes = enc(DOC);
    const text = await collect(new MemoryArchive(bytes, 1), expected(bytes));
    expect(text).toBe(DOC);
  });

  it('ref naming another tenant/feed/fetch → ARCHIVE_REF_MISMATCH', async () => {
    const bytes = enc(DOC);
    const e = expected(bytes);
    const foreign = buildArchiveRef({
      tenantId: randomUUID(),
      feedId: e.feedId,
      fetchId: e.fetchId,
      format: 'CUSTOM_XML',
    });
    await expect(verifyArchiveIntegrity(new MemoryArchive(bytes), { ...e, ref: foreign })).rejects.toMatchObject({
      code: 'ARCHIVE_REF_MISMATCH',
    });
    await expect(
      verifyArchiveIntegrity(new MemoryArchive(bytes), { ...e, ref: 'feed-archive://../../etc/passwd' }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_REF_INVALID' });
  });

  it('format mismatch (csv ref for an XML fetch) → ARCHIVE_REF_MISMATCH', async () => {
    const bytes = enc(DOC);
    const e = expected(bytes);
    const csvRef = buildArchiveRef({ tenantId: e.tenantId, feedId: e.feedId, fetchId: e.fetchId, format: 'CSV' });
    await expect(verifyArchiveIntegrity(new MemoryArchive(bytes), { ...e, ref: csvRef })).rejects.toMatchObject({
      code: 'ARCHIVE_REF_MISMATCH',
    });
  });

  it('tampered bytes → ARCHIVE_INTEGRITY_MISMATCH (pass 1 and pass 2)', async () => {
    const bytes = enc(DOC);
    const e = expected(bytes);
    const tampered = enc(DOC.replace('1.299,90', '0,01'));
    await expect(verifyArchiveIntegrity(new MemoryArchive(tampered), e)).rejects.toMatchObject({
      code: 'ARCHIVE_INTEGRITY_MISMATCH',
    });
    await expect(collect(new MemoryArchive(tampered), e)).rejects.toMatchObject({
      code: 'ARCHIVE_INTEGRITY_MISMATCH',
    });
  });

  it('archive larger than the byte cap → ARCHIVE_TOO_LARGE', async () => {
    const bytes = enc(DOC);
    await expect(
      verifyArchiveIntegrity(new MemoryArchive(bytes), expected(bytes, { maxBytes: 100 })),
    ).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
  });

  it.each([
    ['DOCTYPE', '<!DOCTYPE x [<!ENTITY a "b">]><x/>'],
    ['ENTITY', '<x><!ENTITY a "b"></x>'],
    ['SYSTEM ref', '<x a=\'SYSTEM "http://evil/"\'/>'],
  ])('malicious XML regression: %s → XML_SECURITY_REJECTED', async (_label, doc) => {
    const bytes = enc(doc);
    await expect(collect(new MemoryArchive(bytes), expected(bytes))).rejects.toMatchObject({
      code: 'XML_SECURITY_REJECTED',
    });
  });

  it('DOCTYPE after >64 KiB padding and split across chunks is still rejected', async () => {
    const doc = `<x>${' '.repeat(70 * 1024)}<!DOCTYPE y></x>`;
    const bytes = enc(doc);
    // 7-byte chunks guarantee "<!DOCTYPE" straddles a boundary somewhere.
    await expect(collect(new MemoryArchive(bytes, 7), expected(bytes))).rejects.toMatchObject({
      code: 'XML_SECURITY_REJECTED',
    });
  });

  it('UTF-16 BOM / non-UTF-8 charset / declaration → XML_ENCODING_REJECTED', async () => {
    const bom = new Uint8Array([0xff, 0xfe, 0x3c, 0x00]);
    await expect(collect(new MemoryArchive(bom), expected(bom))).rejects.toMatchObject({
      code: 'XML_ENCODING_REJECTED',
    });
    const latin = enc('<x/>');
    await expect(
      collect(new MemoryArchive(latin), expected(latin, { contentType: 'text/xml; charset=iso-8859-9' })),
    ).rejects.toMatchObject({ code: 'XML_ENCODING_REJECTED' });
    const decl = enc('<?xml version="1.0" encoding="windows-1254"?><x/>');
    await expect(collect(new MemoryArchive(decl), expected(decl))).rejects.toMatchObject({
      code: 'XML_ENCODING_REJECTED',
    });
  });

  it('invalid UTF-8 bytes → XML_INVALID_UTF8', async () => {
    const bytes = new Uint8Array([...enc('<x>'), 0xc3, 0x28, ...enc('</x>')]);
    await expect(collect(new MemoryArchive(bytes), expected(bytes))).rejects.toMatchObject({
      code: 'XML_INVALID_UTF8',
    });
  });

  it('consumer errors propagate unchanged (never relabeled as archive errors)', async () => {
    const bytes = enc(DOC);
    const boom = new Error('db down');
    await expect(
      streamVerifiedXmlText(new MemoryArchive(bytes), expected(bytes), () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('archive open failure → ARCHIVE_READ_FAILED', async () => {
    const bytes = enc(DOC);
    const broken: FeedArchive = {
      ...new MemoryArchive(bytes),
      read: async () => {
        throw new Error('ENOENT');
      },
      openWriter: async () => {
        throw new Error('no');
      },
      exists: async () => false,
      delete: async () => {},
    };
    await expect(verifyArchiveIntegrity(broken, expected(bytes))).rejects.toBeInstanceOf(ImportError);
    await expect(verifyArchiveIntegrity(broken, expected(bytes))).rejects.toMatchObject({
      code: 'ARCHIVE_READ_FAILED',
    });
  });
});
