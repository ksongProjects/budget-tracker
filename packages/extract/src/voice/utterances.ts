/**
 * The utterance set the fallback is measured against.
 *
 * Phase 8.2's acceptance is that these parse, so they are kept as data rather
 * than buried in a test: they are the specification of what a person may say to
 * this app and be understood, and they are the thing to extend when someone
 * says something it misses.
 *
 * Written the way a transcriber emits text — lowercase, no punctuation to speak
 * of, numbers sometimes as digits and sometimes as words, because whisper does
 * both depending on how the sentence ran.
 */

export interface Utterance {
  readonly said: string;
  readonly expect: {
    /** Minor units. Absent when the sentence names no amount. */
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly merchant?: string;
    /** Days before "now" the sentence refers to, when it says. */
    readonly daysAgo?: number;
  };
}

export const UTTERANCES: readonly Utterance[] = [
  {
    said: 'twelve bucks on coffee at Blue Bottle',
    expect: { amountMinor: 1200, currency: 'USD', merchant: 'Blue Bottle' },
  },
  {
    said: 'spent $4.50 at Blue Bottle',
    expect: { amountMinor: 450, currency: 'USD', merchant: 'Blue Bottle' },
  },
  {
    said: '$62.18 at Safeway',
    expect: { amountMinor: 6218, currency: 'USD', merchant: 'Safeway' },
  },
  {
    said: 'twenty five pounds at the petrol station',
    expect: { amountMinor: 2500, currency: 'GBP', merchant: 'the petrol station' },
  },
  {
    said: 'three quid on a sandwich',
    expect: { amountMinor: 300, currency: 'GBP' },
  },
  {
    said: 'forty euros at the hardware shop yesterday',
    expect: { amountMinor: 4000, currency: 'EUR', merchant: 'the hardware shop', daysAgo: 1 },
  },
  {
    said: '980 yen for ramen',
    // No minor unit in yen; treating it as 9.80 would be wrong by a hundred.
    expect: { amountMinor: 980, currency: 'JPY' },
  },
  {
    said: 'lunch at Tartine, eighteen fifty',
    // "eighteen fifty" is two numbers, not eighteen point fifty. The first one
    // is what this reads, and the user corrects it — better than inventing a
    // decimal the speaker did not say.
    expect: { amountMinor: 1800, currency: 'USD', merchant: 'Tartine' },
  },
  {
    said: 'paid 15 dollars for parking',
    expect: { amountMinor: 1500, currency: 'USD' },
  },
  {
    said: 'coffee',
    // Nothing to read. An empty candidate is the right answer, not a zero.
    expect: {},
  },
  {
    said: 'thirty at the market on Friday',
    expect: { amountMinor: 3000, merchant: 'the market' },
  },
  {
    said: 'seven fifty from the corner shop',
    expect: { amountMinor: 700, merchant: 'the corner shop' },
  },
];
