import { describe, expect, it } from 'vitest';
import {
  contentProblem,
  encodeLfsPointer,
  encodeThumbnailWords,
  GITATTRIBUTES,
  GITATTRIBUTES_PATH,
  imageType,
  LFS_NEEDED,
  lfsKindOf,
  normalizePath,
  parseLfsPointer,
  parseThumbnailWords,
  pathDenied,
  THUMBNAIL_PATH,
  thumbnailImagePath,
  thumbnailImageType,
  type Roles,
} from '@/server/pages/rules';

const SHA = 'b'.repeat(64);
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize 300000\n`;

describe('a Git LFS pointer', () => {
  it('is the three lines git lfs writes', () => {
    expect(parseLfsPointer(POINTER)).toEqual({ sha256: SHA, bytes: 300_000 });
    expect(encodeLfsPointer({ sha256: SHA, bytes: 300_000 })).toBe(POINTER);
    for (const bad of [
      POINTER.replace('sha256:', 'sha1:'),
      POINTER.replace(SHA, 'B'.repeat(64)),
      POINTER.replace('size 300000', 'size 0300000'),
      POINTER.replace('size 300000', 'size -1'),
      POINTER.trimEnd(),
      `${POINTER}ext-0-foo sha256:${SHA}\n`,
      'GIF89a',
    ]) {
      expect(parseLfsPointer(bad)).toBeNull();
    }
  });

  it('is what a PDF or the picture has to be', () => {
    expect(lfsKindOf('.potentialpaper/paper.pdf')).toBe('pdf');
    expect(lfsKindOf('versions/v_k3x9q2ab.pdf')).toBe('pdf');
    expect(lfsKindOf('thumbnail.png')).toBe('image');
    expect(lfsKindOf('thumbnail.json')).toBeNull();
    expect(lfsKindOf('community/10-x.md')).toBeNull();
    expect(contentProblem('thumbnail.png', POINTER)).toBeNull();
    expect(contentProblem('thumbnail.png', 'GIF89a…')).toBe(LFS_NEEDED);
    expect(contentProblem('thumbnail.gif', encodeLfsPointer({ sha256: SHA, bytes: 9 * 1024 * 1024 }))).toMatch(
      /larger/,
    );
    expect(
      contentProblem('versions/v_k3x9q2ab.pdf', encodeLfsPointer({ sha256: SHA, bytes: 39 * 1024 * 1024 })),
    ).toBeNull();
  });
});

describe('the picture', () => {
  it('is named for its type, with its words beside it', () => {
    expect(thumbnailImageType('thumbnail.jpg')).toBe('image/jpeg');
    expect(thumbnailImageType('thumbnail.jpeg')).toBe('image/jpeg');
    expect(thumbnailImageType('thumbnail.svg')).toBeNull();
    expect(thumbnailImageType('community/thumbnail.png')).toBeNull();
    expect(thumbnailImagePath('image/jpeg')).toBe('thumbnail.jpg');
    expect(parseThumbnailWords(encodeThumbnailWords({ alt: 'x', caption: 'y' }))).toEqual({ alt: 'x', caption: 'y' });
    expect(parseThumbnailWords('{}')).toEqual({});
    for (const bad of ['[]', '{"alt":3}', `{"caption":"${'x'.repeat(501)}"}`, `{"url":"https://x.org/t.gif"}`]) {
      expect(parseThumbnailWords(bad)).toBeNull();
    }
    expect(contentProblem(THUMBNAIL_PATH, '{"sha256":"x"}')).toMatch(/alt/);
  });

  it("is the card's, as the links are", () => {
    const roles: Roles = { system: false, admin: false, verified: true, confirmedAuthor: false, claimed: true };
    expect(pathDenied('thumbnail.png', roles)).toMatch(/confirmed authors/);
    expect(pathDenied('thumbnail.png', { ...roles, confirmedAuthor: true })).toBeNull();
    expect(pathDenied('thumbnail.png', { ...roles, claimed: false })).toBeNull();
  });
});

describe('.gitattributes', () => {
  it("is at the top, the system's, and always the same", () => {
    expect(normalizePath(GITATTRIBUTES_PATH)).toEqual({ path: GITATTRIBUTES_PATH });
    expect(normalizePath('community/.gitattributes')).toHaveProperty('problem');
    const roles: Roles = { system: false, admin: false, verified: true, confirmedAuthor: true, claimed: true };
    expect(pathDenied(GITATTRIBUTES_PATH, roles)).toMatch(/only the system and admins/);
    expect(contentProblem(GITATTRIBUTES_PATH, GITATTRIBUTES)).toBeNull();
    expect(contentProblem(GITATTRIBUTES_PATH, `${GITATTRIBUTES}*.md filter=x\n`)).toMatch(/fixed/);
    for (const line of GITATTRIBUTES.split('\n').filter((l) => l.startsWith('/'))) {
      expect(line).toMatch(/ filter=lfs diff=lfs merge=lfs -text$/);
    }
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
