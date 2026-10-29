// Market hours schedule — data-driven, timezone-aware, covers all major markets
export type MarketStatus = 'open' | 'closed' | 'pre-market' | 'after-hours' | 'maintenance';

interface MarketSession { open: number; close: number; } // minutes from midnight in market timezone

interface MarketSchedule {
  timezone: string;
  days: number[];          // UTC days (0=Sun, 6=Sat)
  sessions: MarketSession[];
  preMarket?: MarketSession;
  afterHours?: MarketSession;
  dailyBreak?: MarketSession; // maintenance window
}

// All times in 24h minutes from midnight in the market's local timezone
const SCHEDULES: Record<string, MarketSchedule> = {
  // ─── US Equities (NYSE / NASDAQ) — America/New_York ───────
  equity: {
    timezone: 'America/New_York',
    days: [1, 2, 3, 4, 5], // Mon-Fri
    sessions: [{ open: 9 * 60 + 30, close: 16 * 60 }], // 9:30-16:00
    preMarket: { open: 4 * 60, close: 9 * 60 + 30 },    // 4:00-9:30
    afterHours: { open: 16 * 60, close: 20 * 60 },       // 16:00-20:00
  },

  // ─── US Futures (CME) — America/Chicago ──────────────────
  // Sun 17:00 CT open, runs continuously until Fri 16:00 CT
  // except daily maintenance break 16:00-17:00 CT Mon-Thu
  futures: {
    timezone: 'America/Chicago',
    days: [0, 1, 2, 3, 4, 5], // Sun(open) through Fri(close)
    sessions: [{ open: 0, close: 24 * 60 }], // placeholder, handled specially
    dailyBreak: { open: 16 * 60, close: 17 * 60 }, // 16:00-17:00 CT maintenance
  },

  // ─── Forex — global 24/5, Sunday 17:00 ET to Friday 17:00 ET ──
  forex: {
    timezone: 'America/New_York',
    days: [0, 1, 2, 3, 4, 5], // Sun(open) through Fri(close)
    sessions: [{ open: 0, close: 24 * 60 }],
  },

  // ─── Crypto — always open ────────────────────────────────
  crypto: {
    timezone: 'UTC',
    days: [0, 1, 2, 3, 4, 5, 6],
    sessions: [{ open: 0, close: 24 * 60 }],
  },

  // ─── European Equities (XETRA/LSE) — Europe/London ────────
  europe: {
    timezone: 'Europe/London',
    days: [1, 2, 3, 4, 5], // Mon-Fri
    sessions: [{ open: 8 * 60, close: 16 * 60 + 30 }], // 8:00-16:30
  },

  // ─── Asian Equities (TSE) — Asia/Tokyo ────────────────────
  asia: {
    timezone: 'Asia/Tokyo',
    days: [1, 2, 3, 4, 5], // Mon-Fri
    sessions: [{ open: 9 * 60, close: 15 * 60 }], // 9:00-15:00 with lunch break
    dailyBreak: { open: 11 * 60 + 30, close: 12 * 60 + 30 }, // 11:30-12:30 lunch
  },
};

/** Get the current time in a given IANA timezone, returned as minutes since midnight */
function timeInZone(tz: string): { day: number; minutes: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[map.weekday] ?? now.getUTCDay();
  const minutes = (parseInt(map.hour) || 0) * 60 + (parseInt(map.minute) || 0);
  return { day, minutes };
}

function checkSchedule(schedule: MarketSchedule): MarketStatus {
  const { day, minutes } = timeInZone(schedule.timezone);

  // Check if today is a trading day
  if (!schedule.days.includes(day)) return 'closed';

  // Special handling for CME futures
  if (schedule === SCHEDULES.futures) {
    // Sunday: opens at 17:00 CT
    if (day === 0) return minutes >= 17 * 60 ? 'open' : 'closed';
    // Friday: closes at 16:00 CT
    if (day === 5) return minutes < 16 * 60 ? 'open' : 'closed';
    // Mon-Thu: continuous except 16:00-17:00 maintenance
    if (day >= 1 && day <= 4) {
      if (minutes >= 16 * 60 && minutes < 17 * 60) return 'maintenance';
      return 'open';
    }
    return 'closed';
  }

  // Special handling for forex (Sun 17:00 ET to Fri 17:00 ET)
  if (schedule === SCHEDULES.forex) {
    if (day === 0) return minutes >= 17 * 60 ? 'open' : 'closed';
    if (day === 5) return minutes < 17 * 60 ? 'open' : 'closed';
    if (day === 6) return 'closed';
    return 'open';
  }

  // Check daily break / maintenance window
  if (schedule.dailyBreak) {
    const b = schedule.dailyBreak;
    if (minutes >= b.open && minutes < b.close) return 'maintenance';
  }

  // Check pre-market
  if (schedule.preMarket) {
    const pm = schedule.preMarket;
    if (minutes >= pm.open && minutes < pm.close) return 'pre-market';
  }

  // Check regular session
  for (const s of schedule.sessions) {
    if (minutes >= s.open && minutes < s.close) return 'open';
  }

  // Check after-hours
  if (schedule.afterHours) {
    const ah = schedule.afterHours;
    if (minutes >= ah.open && minutes < ah.close) return 'after-hours';
  }

  return 'closed';
}

/** Determine which market schedule applies to a symbol */
function scheduleForSymbol(symbol: string): MarketSchedule {
  const sym = symbol.toUpperCase();

  // Crypto
  if (/-USD$/.test(sym) || sym === 'BTCUSD' || sym === 'ETHUSD') return SCHEDULES.crypto;

  // Forex
  if (/=X$/.test(sym)) return SCHEDULES.forex;
  if (/^(EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY)/.test(sym) && (sym.includes('USD') || sym.includes('EUR') || sym.includes('GBP') || sym.includes('JPY') || sym.includes('CHF') || sym.includes('CAD') || sym.includes('AUD') || sym.includes('NZD'))) {
    return SCHEDULES.forex;
  }

  // Futures
  if (/=F$/.test(sym)) return SCHEDULES.futures;
  if (['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'SI', 'NG', 'ZB', 'ZN', 'ZC', 'ZW', 'CT', 'HG', 'PA', 'PL'].includes(sym)) return SCHEDULES.futures;

  // Asian equities (numeric tickers like 7203.T, 9984.T)
  if (/\.T$/.test(sym) || /^\d/.test(sym)) return SCHEDULES.asia;

  // European equities (suffixes like .L, .DE, .PA)
  if (/\.L$|\.DE$|\.PA$|\.AS$|\.MI$/.test(sym)) return SCHEDULES.europe;

  // Default: US equities
  return SCHEDULES.equity;
}

export function getMarketStatus(symbol: string): MarketStatus {
  return checkSchedule(scheduleForSymbol(symbol));
}

export function marketStatusLabel(status: MarketStatus): string {
  switch (status) {
    case 'open': return 'Market Open';
    case 'closed': return 'Market Closed';
    case 'pre-market': return 'Pre-Market';
    case 'after-hours': return 'After Hours';
    case 'maintenance': return 'Maintenance';
  }
}
