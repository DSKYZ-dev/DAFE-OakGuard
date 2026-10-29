export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'] as const;
export type Currency = typeof SUPPORTED_CURRENCIES[number];

/** Best-effort currency detection from a ticker symbol — forex pairs quote in
 * their second leg, everything else (equities, futures, crypto) defaults USD. */
export function detectCurrency(symbol: string): Currency {
  const s = symbol.toUpperCase().replace(/[=X]/g, '');
  const fxQuote: Record<string, Currency> = {
    USDJPY: 'JPY', EURJPY: 'JPY', GBPJPY: 'JPY',
    EURUSD: 'USD', GBPUSD: 'USD', AUDUSD: 'USD', NZDUSD: 'USD',
    USDCHF: 'CHF', USDCAD: 'CAD', EURGBP: 'GBP', EURCHF: 'CHF',
  };
  if (fxQuote[s]) return fxQuote[s];
  if (/^[A-Z]{6}$/.test(s)) {
    const quote = s.slice(3) as Currency;
    if ((SUPPORTED_CURRENCIES as readonly string[]).includes(quote)) return quote;
  }
  return 'USD';
}
