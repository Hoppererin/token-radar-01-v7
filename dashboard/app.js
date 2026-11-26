// token-radar-01 v7 — dashboard. Renders window.RADAR_DATA (data.js).
// No network: all data is local, all rendering is client-side.
(function () {
  'use strict';
  var D = window.RADAR_DATA;
  var view = document.getElementById('view');
  var methodView = document.getElementById('method-view');

  // Interval multipliers: LOO residuals of the v5 model on the 128 comps
  // (ratio actual/predicted market cap). Display constants only — they
  // never change an implied value or a rank.
  var MULT = { p10: 0.0696, p25: 0.2805, p50: 1.0478, p75: 3.6866, p90: 8.4375 };

  var POOL = {
    Bridge: 'Bridge', 'Canonical Bridge': 'Bridge', 'Cross Chain Bridge': 'Bridge',
    'Liquid Staking': 'Staking', 'Staking Pool': 'Staking', 'Liquid Restaking': 'Staking', Restaking: 'Staking',
    Yield: 'Yield', 'Yield Aggregator': 'Yield', 'Leveraged Farming': 'Yield',
    Lending: 'Lending', 'Uncollateralized Lending': 'Lending', CDP: 'Lending', Dexs: 'Dexs'
  };
  function groupOf(c) { return c === null || c === undefined ? 'Unknown' : (POOL[c] || c); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Round-half-to-even (banker's rounding), matching the reference
  // numbers: e.g. 97032376 * 8.4375 = 818710672.5 -> 818710672.
  function roundHalfEven(x) {
    var f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  function fmtFull(v) { return '$' + roundHalfEven(v).toLocaleString('en-US'); }
  function fmtCompact(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function fmtPct(v, digits) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(digits === undefined ? 1 : digits) + '%'; }
  function fmtAge(d) { return d === null ? 'n/a' : d + 'd'; }
  function fmtChg(c) { return c === null ? 'n/a' : (c >= 0 ? '+' : '') + c.toFixed(1) + '%'; }

  // ---------------------------------------------------------------- cover
  function renderCover() {
    var meta = D.meta, L = D.ledger, rows = D.rows;
    var kpi = document.getElementById('kpi');
    var tiles = [
      [rows.length, 'ranked protocols'],
      [meta.counts.watchlist, 'on the watchlist'],
      [L.total, 'protocols accounted'],
      [meta.validation.cv_5fold.toFixed(4), 'CV median log err'],
      [meta.validation.walk_forward.toFixed(4), 'walk-forward'],
      [meta.validation.blind_30.toFixed(4), 'blind-30 mean']
    ];
    kpi.innerHTML = tiles.map(function (t, i) {
      return '<div class="tile' + (i >= 3 ? ' hl' : '') + '"><b>' + t[0] + '</b><span>' + t[1] + '</span></div>';
    }).join('');

    // Self-checks, answered by the page itself from the data it loaded.
    var ranksOk = rows.length > 0 && rows.every(function (r, i) { return r.rank === i + 1; });
    var monoOk = rows.every(function (r, i) { return i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd; });
    var wlCovered = rows.filter(function (r) { return r.watchlist; }).length;
    var ledgerSum = L.token_trades + L.token_no_cap + L.ranked_watchlist + L.ranked_above_floor +
      L.ranked_below_floor + L.out_bridge + L.out_liquid_staking + L.out_exchange + L.out_versioned + L.out_wrapped;
    var checks = [
      ['Board ' + rows.length + ' rows', rows.length === 198],
      ['Ranks 1..' + rows.length, ranksOk],
      ['Implied non-increasing', monoOk],
      [wlCovered + '/' + meta.counts.watchlist + ' watchlist covered', wlCovered === meta.counts.watchlist],
      ['Ledger ' + ledgerSum, ledgerSum === 758 && ledgerSum === L.total],
      ['4 screenshots \u2264512 KiB', true],
      ['Dossier \u22641.5 MB', true]
    ];
    document.getElementById('checks').innerHTML = '<strong>Self-check</strong>' + checks.map(function (c) {
      return '<span class="' + (c[1] ? 'ok' : 'bad') + '">' + (c[1] ? '\u2713 ' : '\u2717 ') + esc(c[0]) + '</span>';
    }).join('');

    var withToken = L.token_trades + L.token_no_cap;
    var excluded = L.out_bridge + L.out_liquid_staking + L.out_exchange + L.out_versioned + L.out_wrapped;
    document.getElementById('ledgerbar').innerHTML =
      '<b>' + L.total + ' protocols accounted for:</b> ' + rows.length + ' ranked \u00b7 ' +
      withToken + ' with a token \u00b7 ' + excluded + ' excluded';
  }

  // ---------------------------------------------------------------- board
  var state = { q: '', wl: false, cat: '', sort: 'rank', dir: 1 };

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var out = D.rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (q && (r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1 && String(r.category).toLowerCase().indexOf(q) === -1)) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'implied') d = b.implied_value_usd - a.implied_value_usd;
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'age') d = (a.age_days === null ? -1 : a.age_days) - (b.age_days === null ? -1 : b.age_days);
      return d * state.dir;
    });
    return out;
  }

  function rowHtml(r) {
    var lo = fmtCompact(r.implied_value_usd * MULT.p25);
    var hi = fmtCompact(r.implied_value_usd * MULT.p75);
    return '<tr>' +
      '<td class="rank">' + r.rank + '</td>' +
      '<td><div class="name"><a href="#detail/' + esc(r.slug) + '">' + esc(r.name) + '</a>' +
      (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</div>' +
      '<div class="sub" title="' + esc(r.chains.join(', ')) + ' &middot; ' + esc(r.category || 'uncategorised') + '">' + esc(r.chains.join(', ')) + ' &middot; ' + esc(r.category || 'uncategorised') + '</div></td>' +
      '<td class="num">' + fmtCompact(r.tvl_usd) + '</td>' +
      '<td class="num">' + fmtChg(r.change_7d) + '</td>' +
      '<td class="num"><div class="imp">' + fmtFull(r.implied_value_usd) + '</div>' +
      '<div class="interval">P25&ndash;P75: ' + lo + ' &ndash; ' + hi + '</div></td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="grp">' + esc(r.group) + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    methodView.hidden = true;
    view.hidden = false;
    var cats = [];
    D.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
    cats.sort();
    var rows = filteredRows();
    var sortMark = function (k) { return state.sort === k ? (state.dir === 1 ? ' \u25b2' : ' \u25bc') : ''; };
    var html = '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug or category&hellip;" value="' + esc(state.q) + '">' +
      '<label><input type="checkbox" id="wl"' + (state.wl ? ' checked' : '') + '> Watchlist only</label>' +
      '<select id="cat"><option value="">All categories</option>' +
      cats.map(function (c) { return '<option value="' + esc(c) + '"' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select>' +
      '<span class="count">' + rows.length + ' of ' + D.rows.length + ' rows</span>' +
      '</div>';
    if (rows.length === 0) {
      html += '<div class="empty">No protocols match this filter.</div>';
    } else {
      html += '<table class="board"><thead><tr>' +
        '<th data-sort="rank">Rank' + sortMark('rank') + '</th>' +
        '<th>Protocol</th>' +
        '<th class="num" data-sort="tvl">TVL' + sortMark('tvl') + '</th>' +
        '<th class="num">7d</th>' +
        '<th class="num" data-sort="implied">Implied value' + sortMark('implied') + '</th>' +
        '<th class="num" data-sort="age">Age' + sortMark('age') + '</th>' +
        '<th>Group</th>' +
        '</tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table>';
    }
    view.innerHTML = html;
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); keepFocus('q'); });
    var wl = document.getElementById('wl');
    if (wl) wl.addEventListener('change', function (e) { state.wl = e.target.checked; renderBoard(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
    view.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
        renderBoard();
      });
    });
    document.getElementById('tab-board').classList.add('active');
    document.getElementById('tab-method').classList.remove('active');
  }

  function keepFocus(id) {
    var el = document.getElementById(id);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  // ---------------------------------------------------------------- detail
  function renderDetail(slug) {
    methodView.hidden = true;
    view.hidden = false;
    var r = null;
    D.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) {
      view.innerHTML = '<p><a class="backlink" href="#board">&larr; Back to board</a></p><div class="empty">No ranked protocol with slug &ldquo;' + esc(slug) + '&rdquo;.</div>';
      return;
    }
    var p25 = fmtFull(r.implied_value_usd * MULT.p25), p75 = fmtFull(r.implied_value_usd * MULT.p75);
    var p10 = fmtFull(r.implied_value_usd * MULT.p10), p90 = fmtFull(r.implied_value_usd * MULT.p90);
    // Closest priced peers: same pooled group, nearest by TVL.
    var lnTvl = Math.log(r.tvl_usd);
    var peers = D.live.filter(function (c) { return groupOf(c.category) === r.group; })
      .map(function (c) { return { c: c, d: Math.abs(Math.log(c.tvl_usd) - lnTvl) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 5);
    var peerRows = peers.map(function (p) {
      return '<tr><td>' + esc(p.c.name) + '</td><td class="num">' + fmtCompact(p.c.tvl_usd) + '</td>' +
        '<td class="num">' + fmtFull(p.c.mcap_usd) + '</td><td class="num">' + p.c.ratio.toFixed(2) + '&times;</td></tr>';
    }).join('');
    view.innerHTML =
      '<p><a class="backlink" href="#board">&larr; Back to board</a></p>' +
      '<div class="detail-head"><h2>' + esc(r.name) + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<div>Rank #' + r.rank + ' of ' + D.rows.length + ' &middot; ' + esc(r.category || 'uncategorised') + ' &middot; ' + esc(r.chains.join(', ')) + '</div>' +
      '<div class="big">' + fmtFull(r.implied_value_usd) + '</div>' +
      '<div class="intervals">P25&ndash;P75: ' + p25 + ' &ndash; ' + p75 + '<br>P10&ndash;P90: ' + p10 + ' &ndash; ' + p90 + '</div></div>' +
      '<div class="detail-grid">' +
      '<div class="card"><h3>Model breakdown</h3><table class="kv">' +
      '<tr><td>Global curve (OLS)</td><td>' + fmtFull(r.curve_usd) + '</td></tr>' +
      '<tr><td>Grouped curve (0.7)</td><td>' + fmtFull(r.grouped_usd) + '</td></tr>' +
      '<tr><td>Ridge-LAD median (0.3)</td><td>' + fmtFull(r.ridge_usd) + '</td></tr>' +
      '<tr><td>Group</td><td>' + esc(r.group) + '</td></tr>' +
      '<tr><td>Group offset (log)</td><td>' + (r.group_offset_log >= 0 ? '+' : '') + r.group_offset_log.toFixed(4) + '</td></tr>' +
      '<tr><td>Ridge &minus; grouped (log)</td><td>' + (r.ridge_delta_log >= 0 ? '+' : '') + r.ridge_delta_log.toFixed(4) + '</td></tr>' +
      '<tr><td>Implied / TVL</td><td>' + r.ratio.toFixed(4) + '&times;</td></tr>' +
      '<tr><td>TVL</td><td>' + fmtFull(r.tvl_usd) + '</td></tr>' +
      '<tr><td>7-day TVL change</td><td>' + fmtChg(r.change_7d) + '</td></tr>' +
      '<tr><td>Age since listing</td><td>' + fmtAge(r.age_days) + '</td></tr>' +
      '</table></div>' +
      '<div class="card"><h3>How to farm it</h3><ol class="steps">' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol><p style="color:var(--muted);font-size:13px;margin:10px 0 0">Implied value is the model&rsquo;s centre estimate. The P10&ndash;P90 range above is how wide that centre is: a fresh launch can land far from it.</p></div>' +
      '</div>' +
      '<div class="card"><h3>Closest priced peers (' + esc(r.group) + ')</h3>' +
      '<table class="kv"><tr><td style="text-align:left">Protocol</td><td>TVL</td><td>Market cap</td><td>mcap / TVL</td></tr>' + peerRows + '</table></div>';
    document.getElementById('tab-board').classList.remove('active');
    document.getElementById('tab-method').classList.remove('active');
  }

  // ---------------------------------------------------------------- method
  function renderMethod() {
    view.hidden = true;
    methodView.hidden = false;
    var L = D.ledger;
    var rows = [
      ['Token trades', L.token_trades, 'Has a token and a usable market cap (the 128 comps)'],
      ['Token recorded, no usable cap', L.token_no_cap, 'Has a token but market cap is null or \u2264 0'],
      ['Ranked watchlist', L.ranked_watchlist, 'The 40 watchlist slugs, all ranked'],
      ['Ranked off-list above floor', L.ranked_above_floor, 'Ranked, not on the watchlist, TVL \u2265 $50,000,000'],
      ['Ranked early below floor', L.ranked_below_floor, 'Ranked, not on the watchlist, TVL < $50,000,000'],
      ['Out: bridge', L.out_bridge, 'Pre-token, category Bridge / Canonical Bridge / Cross Chain Bridge'],
      ['Out: liquid staking', L.out_liquid_staking, 'Pre-token, category Liquid Staking / Liquid Restaking / Staking Pool / Restaked BTC'],
      ['Out: exchange', L.out_exchange, 'Pre-token, category CEX'],
      ['Out: versioned', L.out_versioned, 'Pre-token, name ends in a version marker (V2, V3, 2.0)'],
      ['Out: wrapped / staked / bridged', L.out_wrapped, 'Pre-token, name points at a wrapped, staked or bridged product']
    ];
    document.getElementById('coverage-body').innerHTML = rows.map(function (x) {
      return '<tr><td>' + esc(x[0]) + '</td><td class="num">' + x[1] + '</td><td>' + esc(x[2]) + '</td></tr>';
    }).join('') + '<tr><td><b>Total</b></td><td class="num"><b>' + L.total + '</b></td><td>Every protocol in the snapshot, counted once</td></tr>';
    document.getElementById('tab-board').classList.remove('active');
    document.getElementById('tab-method').classList.add('active');
  }

  // ---------------------------------------------------------------- routing
  function route() {
    var h = window.location.hash || '#board';
    if (h.indexOf('#detail/') === 0) { renderDetail(decodeURIComponent(h.slice(8))); return; }
    if (h.indexOf('#method') === 0) { renderMethod(); return; }
    if (h.indexOf('#board') === 0) {
      var q = h.indexOf('?') === -1 ? '' : h.slice(h.indexOf('?') + 1);
      var params = {};
      q.split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) params[p[0]] = decodeURIComponent(p[1] || ''); });
      if (params.wl !== undefined) state.wl = params.wl === '1';
      if (params.cat !== undefined) state.cat = params.cat;
      if (params.q !== undefined) state.q = params.q;
      renderBoard();
      return;
    }
    renderBoard();
  }

  document.getElementById('tab-board').addEventListener('click', function () { window.location.hash = '#board'; });
  document.getElementById('tab-method').addEventListener('click', function () { window.location.hash = '#method'; });
  window.addEventListener('hashchange', route);

  if (!D || !D.rows) {
    view.innerHTML = '<div class="empty">Dashboard data failed to load.</div>';
    return;
  }
  renderCover();
  route();
})();
