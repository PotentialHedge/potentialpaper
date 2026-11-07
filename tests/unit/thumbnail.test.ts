import { describe, expect, it } from 'vitest';
import { contentProblem, imageType, parseThumbnailPointer, THUMBNAIL_PATH } from '@/server/pages/rules';

const POINTER = { sha256: 'b'.repeat(64), bytes: 300_000, type: 'image/gif', url: 'https://pdfs.example.org/t.gif' };

describe('a thumbnail pointer', () => {
  it('takes an image on https or on this site', () => {
    expect(parseThumbnailPointer(JSON.stringify(POINTER))).toEqual(POINTER);
    expect(
      parseThumbnailPointer(JSON.stringify({ ...POINTER, url: '/thumbnails/t.gif', alt: 'x', caption: 'y' })),
    ).toMatchObject({ url: '/thumbnails/t.gif', alt: 'x', caption: 'y' });
  });

  it('refuses anything a page could not safely show', () => {
    for (const bad of [
      { ...POINTER, url: 'http://example.org/t.gif' },
      { ...POINTER, url: '//example.org/t.gif' },
      { ...POINTER, url: '/\\example.org/t.gif' },
      { ...POINTER, url: 'data:image/gif;base64,R0lG' },
      { ...POINTER, type: 'image/svg+xml' },
      { ...POINTER, sha256: 'B'.repeat(64) },
      { ...POINTER, bytes: 0 },
      { ...POINTER, bytes: 9 * 1024 * 1024 },
      { ...POINTER, alt: 3 },
      { ...POINTER, caption: 'x'.repeat(501) },
    ]) {
      expect(parseThumbnailPointer(JSON.stringify(bad))).toBeNull();
    }
    expect(parseThumbnailPointer('[]')).toBeNull();
    expect(contentProblem(THUMBNAIL_PATH, '{}')).toBe('is not a valid thumbnail pointer');
  });
});

describe('telling an image by its bytes', () => {
  const bytes = (...parts: (string | number[])[]) =>
    new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)));

  it('knows the types a thumbnail can be', () => {
    expect(imageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(bytes([0x89], 'PNG\r\n\x1a\n'))).toBe('image/png');
    expect(imageType(bytes('GIF89a', [1, 0]))).toBe('image/gif');
    expect(imageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(imageType(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('image/avif');
    expect(imageType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
});
