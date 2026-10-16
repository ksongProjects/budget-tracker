import { describe, expect, it } from 'vitest';
import { kindOfFile } from './file-kind';

describe('what an uploaded file is', () => {
  it.each([
    ['statement.csv', 'text/csv', 'csv'],
    ['statement.csv', 'text/comma-separated-values', 'csv'],
    ['statement.csv', 'application/vnd.ms-excel', 'csv'],
    ['export', 'text/plain', 'csv'],
    ['statement.pdf', 'application/pdf', 'pdf'],
    ['statement.PDF', undefined, 'pdf'],
    ['download', 'application/pdf', 'pdf'],
    ['receipt.jpg', 'image/jpeg', 'image'],
    ['Screenshot_2026.png', 'image/png', 'image'],
    ['IMG_0412.HEIC', 'application/octet-stream', 'image'],
    ['mystery', undefined, 'csv'],
    ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'unknown'],
    ['song.mp3', 'audio/mpeg', 'unknown'],
  ] as const)('%s (%s) is %s', (name, type, kind) => {
    expect(kindOfFile(name, type)).toBe(kind);
  });
});
