import { parseAmount, cellText, cellPlainValue } from '@/lib/ingestion/excel-values';

describe('parseAmount', () => {
  test('numbers and blanks', () => {
    expect(parseAmount(12.5)).toBe(12.5);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('-')).toBe(0);
  });
  test('text typed numbers keep their value', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('2,00,000')).toBe(200000);
    expect(parseAmount('₹ 1,000')).toBe(1000);
    expect(parseAmount('(500)')).toBe(-500);
    expect(parseAmount('-500')).toBe(-500);
    expect(parseAmount('500 Cr')).toBe(-500);
    expect(parseAmount('500 Dr')).toBe(500);
  });
  test('formula results and rich text are unwrapped', () => {
    expect(parseAmount({ formula: 'A1+1', result: 7 })).toBe(7);
    expect(parseAmount({ richText: [{ text: '1,0' }, { text: '00' }] })).toBe(1000);
  });
  test('garbage is refused (null), not stored as 0 or a part of it', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('12abc')).toBeNull();
  });
});

describe('cellText', () => {
  test('rich text and hyperlinks become plain text, never [object Object]', () => {
    expect(cellText({ richText: [{ text: 'Sales ' }, { text: 'Domestic' }] })).toBe('Sales Domestic');
    expect(cellText({ text: 'Cash', hyperlink: 'x' })).toBe('Cash');
    expect(cellText({ formula: 'x', result: 'Bank' })).toBe('Bank');
    expect(cellText(null)).toBe('');
  });
  test('plain value passthrough', () => { expect(cellPlainValue(5)).toBe(5); });
});
