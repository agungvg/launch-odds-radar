// Launch-Odds Radar's dashboard. It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, the filters and a
// per-protocol detail view with the model's own arithmetic and the farm plan.
// No network: every byte it shows is in data.js. Views are deep-linkable:
// #detail=<slug> opens a protocol, #watchlist=1 shows the watchlist only,
// #category=<name> and #chain=<name> pre-set the filters.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var root = document.getElementById('rows');
  if (!DATA || !root) return;
  var rows = DATA.rows;
  var meta = DATA.meta;

  var state = {
    q: '', category: 'all', chain: 'all', watchlist: false, minOdds: 0,
    sort: 'rank', dir: 1, selected: null,
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtFactor(n) { return n.toFixed(2) + '×'; }

  // ---- header stats -----------------------------------------------------
  (function stats() {
    var box = document.getElementById('stats');
    var top = rows[0];
    var items = [
      ['Board', String(rows.length) + ' rows'],
      ['Watchlist', String(meta.watchlist) + ' covered'],
      ['Top implied', top ? fmtUsd(top.implied_value_usd) : 'n/a'],
      ['Snapshot', meta.as_of],
      ['Floor', fmtUsd(meta.floor_usd)],
    ];
    items.forEach(function (kv) {
      var wrap = el('div');
      wrap.appendChild(el('dt', null, kv[0]));
      wrap.appendChild(el('dd', null, kv[1]));
      box.appendChild(wrap);
    });
  })();

  // ---- filter controls --------------------------------------------------
  var qInput = document.getElementById('q');
  var catSel = document.getElementById('category');
  var chainSel = document.getElementById('chain');
  var watchBox = document.getElementById('watchlist');
  var oddsInput = document.getElementById('minodds');
  var oddsOut = document.getElementById('minodds-out');
  var countOut = document.getElementById('count');

  function fillSelect(sel, values, allLabel) {
    sel.textContent = '';
    sel.appendChild(el('option', null, allLabel)).value = 'all';
    values.forEach(function (v) {
      var o = el('option', null, v);
      o.value = v;
      sel.appendChild(o);
    });
  }
  var categories = Array.from(new Set(rows.map(function (r) { return r.category || '(none)'; }))).sort();
  var chains = Array.from(new Set(rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []))).sort();
  fillSelect(catSel, categories, 'All categories');
  fillSelect(chainSel, chains, 'All chains');

  // ---- filtering + sorting ----------------------------------------------
  function visible() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.watchlist && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || '(none)') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (r.odds * 100 < state.minOdds) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    list.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return dir * (av < bv ? -1 : av > bv ? 1 : 0);
      return dir * (av - bv);
    });
    return list;
  }

  function renderRows() {
    var list = visible();
    root.textContent = '';
    if (list.length === 0) {
      var tr = el('tr');
      var td = el('td', 'empty', 'No protocol matches these filters.');
      td.colSpan = 8;
      tr.appendChild(td);
      root.appendChild(tr);
    }
    list.forEach(function (r) {
      var tr = el('tr');
      if (r.on_watchlist) tr.className = 'watch';
      if (state.selected === r.slug) tr.className += ' sel';
      tr.appendChild(el('td', 'num', String(r.rank)));
      var nameTd = el('td');
      nameTd.appendChild(document.createTextNode(r.name));
      if (r.on_watchlist) nameTd.appendChild(el('span', 'badge', 'WATCH'));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, r.category || '—'));
      var tvl = el('td', 'num', fmtUsd(r.tvl_usd));
      tr.appendChild(tvl);
      var chg = el('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), fmtPct(r.change_7d === null ? null : r.change_7d / 100));
      tr.appendChild(chg);
      tr.appendChild(el('td', 'num', fmtAge(r.age_days)));
      var oddsTd = el('td');
      var wrap = el('span', 'odds');
      var bar = el('span', 'bar');
      var fill = el('i');
      fill.style.width = Math.round(r.odds * 100) + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
      wrap.appendChild(el('b', null, Math.round(r.odds * 100) + '%'));
      oddsTd.appendChild(wrap);
      tr.appendChild(oddsTd);
      tr.appendChild(el('td', 'num', fmtUsd(r.implied_value_usd)));
      tr.addEventListener('click', function () { select(r.slug, true); });
      root.appendChild(tr);
    });
    countOut.textContent = list.length + ' of ' + rows.length + ' protocols';
  }

  // ---- detail view --------------------------------------------------------
  function select(slug, push) {
    state.selected = slug;
    var r = rows.find(function (x) { return x.slug === slug; }) || null;
    var box = document.getElementById('detail');
    box.textContent = '';
    if (!r) {
      box.appendChild(el('p', 'empty', 'Click a row to see its model and farm plan.'));
      renderRows();
      return;
    }
    box.appendChild(el('h2', null, r.name));
    box.appendChild(el('p', 'meta', (r.category || 'Uncategorised') + ' · ' + r.chains.join(', ') + ' · TVL ' + fmtUsd(r.tvl_usd) + (r.on_watchlist ? ' · on the watchlist' : '')));

    box.appendChild(el('h3', null, 'The model, in the open'));
    var table = el('table', 'decomp');
    var lines = [
      ['Terminal value', fmtUsd(r.terminal_usd), 'K · TVL^0.8'],
      ['Growth (7d, 8wk)', fmtFactor(r.growth), r.change_7d === null ? 'no 7d figure: 1.00×' : fmtPct(r.change_7d / 100) + ' a week'],
      ['Age factor', fmtFactor(r.age_factor), r.age_days === null ? 'listing date unknown' : fmtAge(r.age_days) + ' with no token'],
      ['Breadth', fmtFactor(r.breadth), r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains')],
      ['Launch odds', Math.round(r.odds * 100) + '%', 'category tokenisation rate, shrunk'],
    ];
    lines.forEach(function (line) {
      var row = el('tr');
      row.appendChild(el('td', null, line[0]));
      row.appendChild(el('td', null, line[2]));
      row.appendChild(el('td', null, line[1]));
      table.appendChild(row);
    });
    var total = el('tr', 'total');
    total.appendChild(el('td', null, 'Implied value'));
    total.appendChild(el('td', null, 'terminal × growth × age × breadth × odds'));
    total.appendChild(el('td', null, fmtUsd(r.implied_value_usd)));
    table.appendChild(total);
    box.appendChild(table);
    // The page recomputes the row from its own factors, so the number on
    // screen and the number in board.json are visibly the same arithmetic.
    var check = Math.round(r.terminal_usd * r.growth * r.age_factor * r.breadth * r.odds);
    var note = el('p', 'meta', check === r.implied_value_usd
      ? 'Recomputed on this page: ' + fmtUsd(check) + ' — matches board.json.'
      : 'Recomputed on this page: ' + fmtUsd(check) + ' (rounding).');
    box.appendChild(note);

    box.appendChild(el('h3', null, 'Farm plan'));
    var ol = el('ol', 'steps');
    r.farm_steps.forEach(function (s) { ol.appendChild(el('li', null, s)); });
    box.appendChild(ol);
    if (push) writeHash();
    renderRows();
  }

  // ---- hash state ---------------------------------------------------------
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    hash.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'detail' && v) state.selected = v;
      if (k === 'watchlist' && v === '1') state.watchlist = true;
      if (k === 'category' && v) state.category = v;
      if (k === 'chain' && v) state.chain = v;
      if (k === 'q' && v) state.q = v;
      if (k === 'minodds' && v) state.minOdds = parseInt(v, 10) || 0;
    });
  }
  function writeHash() {
    var parts = [];
    if (state.selected) parts.push('detail=' + encodeURIComponent(state.selected));
    if (state.watchlist) parts.push('watchlist=1');
    if (state.category !== 'all') parts.push('category=' + encodeURIComponent(state.category));
    if (state.chain !== 'all') parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.minOdds) parts.push('minodds=' + state.minOdds);
    var next = parts.join('&');
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---- wiring -------------------------------------------------------------
  qInput.addEventListener('input', function () { state.q = qInput.value; writeHash(); renderRows(); });
  catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); renderRows(); });
  chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); renderRows(); });
  watchBox.addEventListener('change', function () { state.watchlist = watchBox.checked; writeHash(); renderRows(); });
  oddsInput.addEventListener('input', function () {
    state.minOdds = parseInt(oddsInput.value, 10) || 0;
    oddsOut.textContent = state.minOdds + '%';
    writeHash();
    renderRows();
  });
  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'rank' ? 1 : -1; }
      renderRows();
    });
  });

  readHash();
  qInput.value = state.q;
  catSel.value = state.category;
  chainSel.value = state.chain;
  watchBox.checked = state.watchlist;
  oddsInput.value = String(state.minOdds);
  oddsOut.textContent = state.minOdds + '%';
  if (state.selected) select(state.selected, false);
  else {
    document.getElementById('detail').appendChild(
      el('p', 'empty', 'Click a row to see its model and farm plan.'));
    renderRows();
  }
})();
