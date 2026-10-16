/**
 * What an uploaded file is, from what the picker says about it.
 *
 * Both signals are unreliable on their own: file providers report a CSV as
 * text/plain, an Excel type, or nothing at all, and a downloaded file can lose
 * its extension. The declared type is trusted where it is specific; the name
 * decides where it is not.
 */
export type FileKind = 'csv' | 'pdf' | 'image' | 'unknown';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
const TEXT_EXTENSIONS = ['.csv', '.txt', '.tsv'];

export function kindOfFile(name: string, mimeType: string | undefined): FileKind {
  const lower = name.toLowerCase();
  const type = (mimeType ?? '').toLowerCase();

  if (type === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return 'image';
  }
  if (
    type.startsWith('text/') ||
    type.includes('csv') ||
    TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
  ) {
    return 'csv';
  }
  // No type and no telling name: try it as a CSV, which says clearly when it
  // is not one, rather than refusing a file that might be.
  if (type === '' || type === 'application/octet-stream') return 'csv';

  return 'unknown';
}
