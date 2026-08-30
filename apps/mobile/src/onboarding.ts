import { loadBrokerSettings, saveBrokerSettings, type BrokerSettings } from './broker-store';
import { tradovateLogin, syncTradovateProfile } from './tradovate';
import { state } from './state';

export interface OnboardingResult {
  settings: BrokerSettings;
}

function field(label: string, type: string, value = '', placeholder = ''): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'onb-field';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  row.appendChild(l);
  row.appendChild(input);
  return { row, input };
}

export function showOnboarding(onDone: (r: OnboardingResult) => void): void {
  const settings = loadBrokerSettings();

  const overlay = document.createElement('div');
  overlay.id = 'onboarding';
  const card = document.createElement('div');
  card.className = 'onb-card';
  overlay.appendChild(card);

  const title = document.createElement('div');
  title.className = 'onb-title';
  const sub = document.createElement('div');
  sub.className = 'onb-sub';
  card.appendChild(title);
  card.appendChild(sub);

  const body = document.createElement('div');
  body.className = 'onb-body';
  card.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'onb-footer';
  card.appendChild(footer);

  document.body.appendChild(overlay);

  function setStatus(msg: string, ok?: boolean): void {
    sub.textContent = msg;
    sub.style.color = ok === undefined ? '' : ok ? 'var(--green)' : 'var(--red)';
  }

  function clear(): void {
    body.replaceChildren();
    footer.replaceChildren();
  }

  function stepBrokerMode(): void {
    clear();
    title.textContent = 'Welcome to DAFE Charts Mobile';
    setStatus('Connect your futures broker, or start with paper trading.');

    const paper = document.createElement('button');
    paper.className = 'onb-option';
    paper.innerHTML = '<b>Paper Trading</b><span>No credentials — practice with the built-in simulator</span>';
    const tv = document.createElement('button');
    tv.className = 'onb-option';
    tv.innerHTML = '<b>Tradovate (futures / prop firms)</b><span>Apex, Topstep, Take Profit Trader, Tradeify and more</span>';

    paper.addEventListener('click', () => {
      settings.mode = 'paper';
      stepRisk();
    });
    tv.addEventListener('click', () => {
      settings.mode = 'tradovate';
      stepTradovate();
    });
    body.appendChild(paper);
    body.appendChild(tv);
  }

  function stepTradovate(): void {
    clear();
    title.textContent = 'Tradovate Connection';
    setStatus('Your prop-firm Tradovate credentials. Stored only on this device.');

    const fName = field('Username', 'text', settings.tradovate.name);
    const fPass = field('Password', 'password', settings.tradovate.password);
    const fApp = field('App ID', 'text', settings.tradovate.appId, 'e.g. DAFE-MOBILE');
    const fSecret = field('App secret', 'password', settings.tradovate.appSecret, 'Optional for API access');
    const fCid = field('Client ID (optional)', 'text', settings.tradovate.cid);
    [fName, fPass, fApp, fSecret, fCid].forEach((f) => body.appendChild(f.row));

    const note = document.createElement('div');
    note.className = 'onb-note';
    note.textContent = 'Tip: prop firms give you these in your dashboard. Data streams live from Tradovate; orders go through them.';
    body.appendChild(note);

    const back = document.createElement('button');
    back.className = 'btn-ghost';
    back.textContent = 'BACK';
    const next = document.createElement('button');
    next.className = 'btn-buy';
    next.textContent = 'TEST & CONTINUE';
    footer.appendChild(back);
    footer.appendChild(next);

    back.addEventListener('click', stepBrokerMode);
    next.addEventListener('click', async () => {
      settings.tradovate = {
        name: fName.input.value.trim(),
        password: fPass.input.value,
        appId: fApp.input.value.trim(),
        appSecret: fSecret.input.value.trim(),
        cid: fCid.input.value.trim(),
      };
      if (!settings.tradovate.name || !settings.tradovate.password) {
        setStatus('Username and password are required.', false);
        return;
      }
      next.disabled = true;
      next.textContent = 'CONNECTING...';
      try {
        const auth = await tradovateLogin(settings.tradovate);
        await syncTradovateProfile();
        setStatus(`Connected as ${auth.name || settings.tradovate.name} — OK`, true);
        saveBrokerSettings(settings);
        stepRisk();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Connection failed', false);
        next.disabled = false;
        next.textContent = 'TEST & CONTINUE';
      }
    });
  }

  function stepRisk(): void {
    clear();
    title.textContent = 'Account Protection';
    setStatus('Adaptive risk rules. You can change these any time in Settings.');

    const r = settings.risk;
    const fDaily = field('Daily loss limit ($)', 'number', String(r.dailyLossLimit));
    const fTrade = field('Max loss per trade ($)', 'number', String(r.maxLossPerTrade));
    const fMax = field('Max contracts', 'number', String(r.maxContracts));
    const fQty = field('Default quantity', 'number', String(r.defaultQty));
    [fDaily, fTrade, fMax, fQty].forEach((f) => body.appendChild(f.row));

    const toggle = (label: string, def: boolean, on: (v: boolean) => void): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'onb-toggle';
      const l = document.createElement('span');
      l.textContent = label;
      const b = document.createElement('button');
      b.className = 'toggle' + (def ? ' on' : '');
      b.textContent = def ? 'ON' : 'OFF';
      b.addEventListener('click', () => {
        const v = !b.classList.contains('on');
        b.classList.toggle('on', v);
        b.textContent = v ? 'ON' : 'OFF';
        on(v);
      });
      row.appendChild(l);
      row.appendChild(b);
      return row;
    };

    body.appendChild(toggle('Volatility-aware sizing', r.volAwareSizing, (v) => { r.volAwareSizing = v; }));
    body.appendChild(toggle('Auto-flatten on daily loss', r.autoFlattenOnDailyLoss, (v) => { r.autoFlattenOnDailyLoss = v; }));
    body.appendChild(toggle('One-click executions', settings.oneClick, (v) => { settings.oneClick = v; }));

    const note = document.createElement('div');
    note.className = 'onb-note';
    note.textContent = 'Trading halts automatically when the daily loss limit is hit. Chandelier and adaptive stops widen in high volatility to avoid stop-outs.';
    body.appendChild(note);

    const done = document.createElement('button');
    done.className = 'btn-buy';
    done.textContent = 'FINISH SETUP';
    footer.appendChild(done);
    done.addEventListener('click', () => {
      r.dailyLossLimit = Math.max(10, parseFloat(fDaily.input.value) || r.dailyLossLimit);
      r.maxLossPerTrade = Math.max(1, parseFloat(fTrade.input.value) || r.maxLossPerTrade);
      r.maxContracts = Math.max(1, Math.round(parseFloat(fMax.input.value) || r.maxContracts));
      r.defaultQty = Math.max(1, Math.round(parseFloat(fQty.input.value) || r.defaultQty));
      settings.risk = r;
      saveBrokerSettings(settings);
      state.onboarded = true;
      overlay.remove();
      onDone({ settings });
    });
  }

  stepBrokerMode();
}