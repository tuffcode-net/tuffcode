import type { Attachment } from '@tuffcode/contracts';

type PathBridge = { getPathForFile: (file: File) => string };

function isPathBridge(value: unknown): value is PathBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getPathForFile' in value &&
    typeof value.getPathForFile === 'function'
  );
}

function bridgeOf(): unknown {
  const scope: unknown = globalThis;
  return typeof scope === 'object' && scope !== null && 'tuffcode' in scope ? scope.tuffcode : null;
}

function legacyPath(file: File): string | null {
  if (!('path' in file)) return null;
  const candidate: unknown = (file as File & { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function filePath(file: File): string | null {
  const bridge = bridgeOf();
  if (isPathBridge(bridge)) {
    const fromBridge = bridge.getPathForFile(file);
    if (fromBridge.length > 0) return fromBridge;
  }
  return legacyPath(file);
}

/** True when a picked File can become a filesystem path in this runtime. */
export function hasFilePathBridge(): boolean {
  return isPathBridge(bridgeOf());
}

/** Image formats the providers accept; anything else is refused at attach time. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Longest edge an image is downscaled to before encoding, matching Codex's ceiling. */
export const MAX_IMAGE_EDGE = 2048;

/** Largest encoded payload one image may carry; the server enforces the same limit. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

const EXTENSION_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The reverse map, for naming an unnamed clipboard image after its type. */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The image MIME type of a File, falling back to its extension when the type is blank. */
export function imageTypeOf(file: File): string | null {
  const declared = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if ((SUPPORTED_IMAGE_TYPES as readonly string[]).includes(declared)) return declared;
  const dot = file.name.lastIndexOf('.');
  if (dot === -1) return null;
  return EXTENSION_TYPE[file.name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True when the File is an image this build can send. */
export function isImageFile(file: File): boolean {
  return imageTypeOf(file) !== null;
}

/** A clipboard screenshot arrives unnamed; give it a name the chip and the model can use. */
export function pastedImageName(type: string, index = 0): string {
  const extension = MIME_EXTENSION[type.split(';', 1)[0]?.trim().toLowerCase() ?? ''] ?? 'png';
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, '');
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `pasted-image-${stamp}${suffix}.${extension}`;
}

/** Decoded byte length of a base64 payload. */
export function base64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

export interface EncodedImage {
  /** Base64 without the `data:` prefix. */
  data: string;
  mimeType: string;
  /** Pixel size after downscaling, for the chip tooltip and the logs. */
  width: number;
  height: number;
}

export type ImageEncodeResult =
  | { ok: true; image: EncodedImage }
  | { ok: false; reason: string };

/** Target size for a bitmap, preserving the aspect ratio and never upscaling. */
export function scaledSize(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): {
  width: number;
  height: number;
} {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** Strips the `data:<type>;base64,` prefix a FileReader result carries. */
export function stripDataUrl(value: string): string {
  const comma = value.indexOf(',');
  return comma === -1 ? value : value.slice(comma + 1);
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    });
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('the image could not be read'));
    });
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscales an image to `MAX_IMAGE_EDGE` and re-encodes it as PNG. The renderer has no
 * image library, so the canvas does the work; a format the canvas cannot decode is
 * refused here rather than sent as bytes the provider would reject.
 */
async function downscale(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const target = scaledSize(bitmap.width, bitmap.height);
    if (target.width === bitmap.width && target.height === bitmap.height) {
      return { blob, width: bitmap.width, height: bitmap.height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('the canvas is unavailable');
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const scaled = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png');
    });
    if (scaled === null) throw new Error('the image could not be re-encoded');
    return { blob: scaled, width: target.width, height: target.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Turns a picked, dropped or pasted File into inline bytes. The renderer owns the
 * encoding because the server may not read outside the worktree, and a screenshot in
 * the clipboard has no filesystem home at all.
 */
export async function encodeImageFile(file: File): Promise<ImageEncodeResult> {
  const mimeType = imageTypeOf(file);
  if (mimeType === null) {
    return { ok: false, reason: `${file.name} is not a PNG, JPEG, GIF or WebP image.` };
  }
  let prepared: { blob: Blob; width: number; height: number };
  try {
    prepared = await downscale(file);
  } catch {
    return { ok: false, reason: `${file.name} could not be decoded as an image.` };
  }
  let dataUrl: string;
  try {
    dataUrl = await readDataUrl(prepared.blob);
  } catch {
    return { ok: false, reason: `${file.name} could not be read after decoding.` };
  }
  const data = stripDataUrl(dataUrl);
  if (data.length === 0) {
    return { ok: false, reason: `${file.name} produced no image data.` };
  }
  const encoded = base64Bytes(data);
  if (encoded > MAX_IMAGE_BASE64_BYTES) {
    const megabytes = (encoded / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `${file.name} is ${megabytes} MB after encoding; the limit is 5 MB.` };
  }
  return {
    ok: true,
    image: { data, mimeType, width: prepared.width, height: prepared.height },
  };
}

/** The wire attachment for an image, carrying base64 instead of a path. */
export function imageAttachment(file: File, image: EncodedImage): Attachment {
  return {
    name: file.name,
    data: image.data,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
  };
}

/**
 * An attachment for a non-image File. It needs a real filesystem path: Electron 32
 * removed `File.path`, so the desktop preload exposes `getPathForFile`. Without that
 * bridge the composer falls back to the folder picker.
 */
export function attachmentFromFile(file: File): Attachment | null {
  const path = filePath(file);
  if (!path) return null;
  const attachment: Attachment = { name: file.name, path };
  if (file.type.length > 0) attachment.mimeType = file.type;
  return attachment;
}

export function attachmentFromFolder(path: string): Attachment {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  const name = segments.at(-1) ?? path;
  return { name, path };
}

/** Files a paste or drop carried, preferring `files` and falling back to `items`. */
export function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  const direct = Array.from(transfer.files);
  if (direct.length > 0) return direct;
  const files: File[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}
