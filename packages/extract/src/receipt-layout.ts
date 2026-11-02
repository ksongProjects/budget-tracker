import { amountPattern, amountsIn } from './receipt.js';
import type { BoundingBox, OcrLine } from './types.js';

/**
 * A receipt photo as a page: straightened, read top to bottom, and with each
 * label joined to the prices printed on its row.
 *
 * Written against a real photo, not a scan: an invoice held in a hand in a
 * car, tilted about two and a half degrees, with a card slip overlapping one
 * side and a checklist column beside the prices. Read line by line in the
 * engine's order, every label picked up the price from a row or two away, and
 * the slip and the checklist became 95 rows of "shopping". Read as a page —
 * level the rows, find the column the prices stand in — it is thirteen lines
 * that add up to the printed total.
 */

/** A line once laid out: its prices joined on, and where the last one stands. */
export interface LaidOutLine extends OcrLine {
  /** Right edge of the line's last amount, when it has one and a box. */
  readonly priceRight?: number;
  /** Left edge of the label part, for finding the description column. */
  readonly labelLeft?: number;
}

/** Steeper than this is not a tilted receipt but a misread, and is left alone. */
const MAX_SLOPE = 0.2;

/**
 * How far apart two lines' centres may be and still share a row, as a fraction
 * of the typical line height. Relative, because ML Kit reports pixels and other
 * engines 0–1.
 */
const SAME_ROW_FRACTION = 0.6;

const centreY = (box: BoundingBox): number => box.y + box.height / 2;
const centreX = (box: BoundingBox): number => box.x + box.width / 2;
const right = (box: BoundingBox): number => box.x + box.width;

export function medianHeight(lines: readonly OcrLine[]): number {
  const heights = lines
    .map((line) => line.box?.height)
    .filter((height): height is number => height !== undefined && height > 0)
    .sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 0;
}

/**
 * The page's tilt, as a slope: how far a row falls per unit across.
 *
 * Measured from the words of each line, which an engine places along the
 * printed row whatever the angle — the line's own box is axis-aligned and says
 * nothing about it. The median, so a line of handwriting or a fold does not
 * set the angle for the page. Zero when nothing can be measured.
 */
export function pageSlope(lines: readonly OcrLine[]): number {
  const slopes: number[] = [];
  for (const line of lines) {
    const words = line.words ?? [];
    const first = words[0]?.box;
    const last = words.at(-1)?.box;
    if (words.length < 2 || first === undefined || last === undefined) continue;

    const across = centreX(last) - centreX(first);
    // Two words a hair apart give a slope that is mostly noise.
    if (across < Math.max(first.height, last.height) * 2) continue;
    slopes.push((centreY(last) - centreY(first)) / across);
  }

  if (slopes.length < 3) return 0;
  slopes.sort((a, b) => a - b);
  const slope = slopes[Math.floor(slopes.length / 2)] ?? 0;
  return Math.abs(slope) > MAX_SLOPE ? 0 : slope;
}

/**
 * Lines with their rows levelled, in reading order: top to bottom, then left
 * to right.
 *
 * Only heights move — each box keeps its size and its place across, and is
 * lifted or lowered by what the tilt adds at that point. Lines without boxes
 * cannot be placed, so a page with any is returned in the engine's order.
 */
export function straighten(lines: readonly OcrLine[]): OcrLine[] {
  if (lines.some((line) => line.box === undefined)) return [...lines];

  const slope = pageSlope(lines);
  const level = (box: BoundingBox): BoundingBox => ({ ...box, y: box.y - slope * centreX(box) });

  const levelled = lines.map((line) => ({
    ...line,
    ...(line.box ? { box: level(line.box) } : {}),
    ...(line.words
      ? { words: line.words.map((word) => ({ ...word, box: level(word.box) })) }
      : {}),
  }));

  const tolerance = medianHeight(levelled) * SAME_ROW_FRACTION;
  return levelled.sort((a, b) => {
    const dy = centreY(a.box as BoundingBox) - centreY(b.box as BoundingBox);
    return Math.abs(dy) > tolerance ? dy : (a.box as BoundingBox).x - (b.box as BoundingBox).x;
  });
}

/**
 * Engines emit a receipt's label column and price column as separate lines:
 * `TAX` and `0.85` arrive apart, and on an invoice so do `1.00` and `142.99`.
 *
 * Each price-only line joins the label nearest to its left on the same row —
 * nearest, not first found, because a checklist or a card slip beside the
 * table has labels on that row too. A row's prices are joined in order across,
 * so the last is the price and anything before it a quantity. Without boxes
 * the lines are returned untouched, since pairing by guesswork invents numbers.
 */
export function joinRows(lines: readonly OcrLine[]): LaidOutLine[] {
  if (lines.some((line) => line.box === undefined)) return [...lines];

  const tolerance = medianHeight(lines) * SAME_ROW_FRACTION;
  const priceOnly = lines.map(isAmountOnly);

  // For each price-only line, the label it belongs to.
  const owner = new Map<number, number>();
  for (const [index, line] of lines.entries()) {
    if (!priceOnly[index]) continue;
    const box = line.box as BoundingBox;

    let best: number | undefined;
    for (const [other, candidate] of lines.entries()) {
      if (priceOnly[other] || amountsIn(candidate.text).length > 0) continue;
      const label = candidate.box as BoundingBox;
      if (Math.abs(centreY(label) - centreY(box)) > tolerance) continue;
      // The label stands to the left of its price.
      if (label.x >= box.x || right(label) > right(box)) continue;
      if (best === undefined || right(label) > right(lines[best]?.box as BoundingBox)) best = other;
    }
    if (best !== undefined) owner.set(index, best);
  }

  const claimed = new Map<number, number[]>();
  for (const [price, label] of owner) claimed.set(label, [...(claimed.get(label) ?? []), price]);

  const out: LaidOutLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (owner.has(index)) continue;
    const box = line.box as BoundingBox;

    const prices = (claimed.get(index) ?? [])
      .map((at) => lines[at] as OcrLine)
      .sort((a, b) => (a.box as BoundingBox).x - (b.box as BoundingBox).x);
    const last = prices.at(-1)?.box;

    if (prices.length === 0) {
      out.push(amountsIn(line.text).length > 0 ? { ...line, priceRight: right(box), labelLeft: box.x } : line);
      continue;
    }

    out.push({
      ...line,
      text: [line.text.trim(), ...prices.map((price) => price.text.trim())].join(' '),
      box: last === undefined ? box : union(box, last),
      ...(last === undefined ? {} : { priceRight: right(last) }),
      labelLeft: box.x,
    });
  }
  return out;
}

/** Straightened, in reading order, labels joined to their prices. */
export function layOut(lines: readonly OcrLine[]): LaidOutLine[] {
  return joinRows(straighten(lines));
}

/**
 * The lines whose prices stand in the receipt's price column, found as a
 * chain: down the page, each price's right edge close to the one above.
 *
 * A chain rather than one x, because a photo is not flat — on the invoice this
 * was written against the column drifts 120 pixels from top to bottom as the
 * paper curls, a step at a time. The longest chain is the receipt's own prices;
 * a card slip's two amounts or a stray number elsewhere are shorter chains.
 *
 * Returns the indexes of the lines in it, or undefined when the page has too
 * few prices, or no boxes, to say.
 */
export function priceColumn(lines: readonly LaidOutLine[]): Set<number> | undefined {
  const height = medianHeight(lines);
  if (height === 0) return undefined;
  const step = height * 1.5;

  const chains: number[][] = [];
  for (const [index, line] of lines.entries()) {
    if (line.priceRight === undefined) continue;
    const edge = line.priceRight;
    const chain = chains.find((members) => {
      const tail = lines[members.at(-1) as number]?.priceRight;
      return tail !== undefined && Math.abs(tail - edge) <= step;
    });
    if (chain) chain.push(index);
    else chains.push([index]);
  }

  const longest = chains.reduce<number[] | undefined>((best, chain) => {
    if (best === undefined || chain.length > best.length) return chain;
    if (chain.length === best.length) {
      const edge = (members: number[]): number => lines[members[0] as number]?.priceRight ?? 0;
      return edge(chain) > edge(best) ? chain : best;
    }
    return best;
  }, undefined);

  return longest !== undefined && longest.length >= 3 ? new Set(longest) : undefined;
}

function isAmountOnly(line: OcrLine): boolean {
  if (amountsIn(line.text).length === 0) return false;
  // Letters left once the amounts are cut out mean a label shares the line.
  // `CA$11.86` is price-only: the country belongs to the amount.
  return !/[a-z]/i.test(line.text.replace(amountPattern(), ''));
}

function union(a: BoundingBox, b: BoundingBox): BoundingBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(right(a), right(b)) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
