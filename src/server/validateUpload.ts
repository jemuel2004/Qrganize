/**
 * Server-side file upload validation.
 *
 * Validates file magic bytes (actual file signatures), not just the
 * client-reported Content-Type. A renamed .php or .js file claiming to
 * be image/jpeg would fail the magic byte check.
 */

// File signature table: MIME type → list of accepted magic byte sequences
const MAGIC_BYTES: Record<string, Uint8Array[]> = {
  'image/jpeg': [new Uint8Array([0xff, 0xd8, 0xff])],
  'image/png':  [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/webp': [new Uint8Array([0x52, 0x49, 0x46, 0x46])], // RIFF (followed by WEBP at offset 8)
  'image/gif':  [
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), // GIF87a
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // GIF89a
  ],
};

function startsWithBytes(buffer: Uint8Array, magic: Uint8Array): boolean {
  if (buffer.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }
  return true;
}

export async function validateImageMagicBytes(
  file: File,
  allowedMimeTypes: string[],
): Promise<{ valid: boolean; reason?: string }> {
  const mimes = allowedMimeTypes.filter(m => MAGIC_BYTES[m]);
  if (mimes.length === 0) return { valid: true }; // no signatures to check

  const headerBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());

  for (const mime of mimes) {
    if (!MAGIC_BYTES[mime]) continue;
    for (const magic of MAGIC_BYTES[mime]) {
      if (startsWithBytes(headerBytes, magic)) return { valid: true };
    }
  }

  return { valid: false, reason: 'File content does not match a valid image format.' };
}
