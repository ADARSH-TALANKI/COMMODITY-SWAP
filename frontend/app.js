/* CommSwap DApp: talks directly to the local Hardhat node (unlocked demo accounts). */
(() => {
  const C = window.COMMSWAP_CONFIG;
  if (!C || !window.ethers) {
    document.body.innerHTML = `<div class="setup"><h2>CommSwap DApp is not configured yet</h2>
      <p>Run these in the project folder, then reload this page:</p>
      <ol><li><code>npx hardhat node</code> (keep it running)</li>
      <li><code>npx hardhat run scripts/deploy.js --network localhost</code></li></ol></div>`;
    return;
  }
  const { ethers } = window;
  const provider = new ethers.JsonRpcProvider(C.rpc, undefined, { pollingInterval: 1000 });
  const iface = new ethers.Interface(C.abi.CommSwap);
  const feedIface = new ethers.Interface(C.abi.Feed);
  const reader = new ethers.Contract(C.commSwap, C.abi.CommSwap, provider);

  const NAMES = ["Oracle Admin", "Alice", "Bob", "Carol", "Dave", "Mallory", "Eve", "Frank"];
  const REQ_STATUS = ["None", "Open", "Finalized", "Cancelled"];
  const SWAP_STATUS = ["None", "Active", "Matured", "Terminated"];

  const S = {
    accounts: [],
    current: 1,
    chainTime: 0,
    fetchedAt: Date.now(),
    commodities: [],
    requests: [],
    swaps: [],
    logs: [],
    me: null,
    busy: false,
  };

  // ------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const fmtEth = (wei, d = 4) => {
    const s = ethers.formatEther(wei);
    const n = Number(s);
    return (Math.abs(n) >= 1e-4 || n === 0 ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : s) + " ETH";
  };
  const fmtPrice = (p) => Number(ethers.formatUnits(p, 8)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const P = (x) => ethers.parseUnits(String(x), 8);
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const nameOf = (a) => {
    if (!a || a === ethers.ZeroAddress) return "—";
    const i = S.accounts.findIndex((x) => x.toLowerCase() === a.toLowerCase());
    return i >= 0 ? NAMES[i] || `Account ${i}` : short(a);
  };
  const me = () => S.accounts[S.current];
  const isMe = (a) => a && me() && a.toLowerCase() === me().toLowerCase();
  const now = () => S.chainTime + Math.floor((Date.now() - S.fetchedAt) / 1000);
  const dur = (s) => {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), r = s % 60;
    if (m >= 60 * 24) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return m ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
  };
  const countdown = (ts, doneText = "now") => `<span class="cd mono" data-ts="${ts}" data-done="${doneText}"></span>`;
  const sym = (id) => (S.commodities[id] ? S.commodities[id].symbol : `#${id}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "err" ? 7000 : 3500);
  }

  function errMsg(e) {
    const raw = e?.reason || e?.info?.error?.message || e?.error?.message || e?.shortMessage || e?.message || String(e);
    const m = raw.match(/reverted with reason string '([^']+)'/) || raw.match(/reason="([^"]+)"/);
    if (m) return m[1];
    if (e?.data && typeof e.data === "string") {
      try { return iface.parseError(e.data)?.name || raw; } catch (_) {}
    }
    return raw.replace(/^Error: /, "").slice(0, 220);
  }

  async function signer(idx = S.current) {
    return provider.getSigner(S.accounts[idx]);
  }

  async function send(label, fn) {
    if (S.busy) return;
    S.busy = true;
    document.body.style.cursor = "progress";
    try {
      const tx = await fn();
      const r = await tx.wait();
      toast(`${label} ✓  (gas ${r.gasUsed.toString()})`, "ok");
    } catch (e) {
      toast(`${label} failed: ${errMsg(e)}`, "err");
      console.error(e);
    } finally {
      S.busy = false;
      document.body.style.cursor = "";
      await refresh();
    }
  }

  async function asMe() {
    return new ethers.Contract(C.commSwap, C.abi.CommSwap, await signer());
  }

  // ------------------------------------------------------------ data load
  async function loadFeedHistory(addr) {
    const f = new ethers.Contract(addr, C.abi.Feed, provider);
    const latest = Number(await f.latestRound());
    const from = Math.max(1, latest - 40);
    const rounds = await Promise.all(
      Array.from({ length: latest - from + 1 }, (_, k) => f.getRoundData(from + k))
    );
    return rounds.map((r) => ({ id: Number(r[0]), p: r[1], t: Number(r[3]) }));
  }

  async function refresh() {
    try {
      const block = await provider.getBlock("latest");
      // Hardhat only mines a block when a tx is sent, so the latest block's timestamp
      // goes stale while idle. Re-anchor the clock only when a NEW block appears,
      // otherwise keep counting forward from the last anchor.
      if (block.number !== S.blockNumber) {
        S.blockNumber = block.number;
        S.chainTime = Number(block.timestamp);
        S.fetchedAt = Date.now();
      }
      $("netStatus").textContent = `● local chain · block ${block.number}`;
      $("netStatus").className = "pill ok";

      const addr = me();
      const [u, bal, wd, fund] = await Promise.all([
        reader.users(addr), provider.getBalance(addr), reader.withdrawable(addr), reader.insuranceFund(),
      ]);
      S.me = { registered: u[0], rep: Number(u[1]), completed: Number(u[2]), defaults: Number(u[3]), bal, wd };
      S.insurance = fund;

      const nc = Number(await reader.commodityCount());
      S.commodities = await Promise.all(
        Array.from({ length: nc }, async (_, i) => {
          const c = await reader.getCommodity(i);
          const hist = await loadFeedHistory(c.feed);
          return { id: i, symbol: c.symbol, feed: c.feed, heartbeat: Number(c.heartbeat), active: c.active, hist, price: hist[hist.length - 1] };
        })
      );

      const nr = Number(await reader.requestCount());
      S.requests = await Promise.all(
        Array.from({ length: nr }, async (_, i) => {
          const [r, acc] = await Promise.all([reader.getRequest(i), reader.getAcceptances(i)]);
          return { id: i, r, acc };
        })
      );

      const ns = Number(await reader.swapCount());
      S.swaps = await Promise.all(
        Array.from({ length: ns }, async (_, i) => {
          const [s, parties] = await Promise.all([reader.getSwap(i), reader.getParties(i)]);
          return { id: i, s, L: parties[0], Sh: parties[1] };
        })
      );

      const repAll = {};
      await Promise.all(S.accounts.slice(0, 8).map(async (a) => { repAll[a.toLowerCase()] = Number((await reader.users(a))[1]); }));
      S.repAll = repAll;

      const logs = await provider.getLogs({ address: C.commSwap, fromBlock: 0, toBlock: "latest" });
      S.logs = logs.map((l) => { try { return { l, ev: iface.parseLog(l) }; } catch (_) { return null; } }).filter(Boolean);

      render();
    } catch (e) {
      console.error(e);
      $("netStatus").textContent = "● node not reachable: run `npx hardhat node`";
      $("netStatus").className = "pill err";
    }
  }

  // ------------------------------------------------------------ render
  function render() {
    renderUser();
    renderOracle();
    renderProto();
    renderKPreview();
    renderRequests();
    renderSwaps();
    renderActivity();
    tick();
  }

  function renderUser() {
    const m = S.me;
    $("userBar").innerHTML = `
      <div class="stat"><span>Account</span><span>${nameOf(me())} <span class="mono" style="font-weight:400;color:var(--muted)">${short(me())}</span></span></div>
      <div class="stat"><span>Wallet balance</span><span class="mono">${fmtEth(m.bal, 3)}</span></div>
      <div class="stat"><span>Registered</span><span>${m.registered ? '<span class="chip ok">yes</span>' : '<span class="chip warn">no</span>'}</span></div>
      <div class="stat"><span>Reputation</span><span>${m.registered ? repBadge(m.rep) : "—"}</span></div>
      <div class="stat"><span>Swaps completed / defaults</span><span class="mono">${m.completed} / ${m.defaults}</span></div>
      <div class="stat"><span>Withdrawable</span><span class="mono">${fmtEth(m.wd)}</span></div>
      <div class="actions">
        ${m.registered ? "" : `<button class="primary" data-action="register">Register (fee ${fmtEth(C.config.registrationFee)})</button>`}
        ${m.wd > 0n ? `<button class="good" data-action="withdraw">Withdraw ${fmtEth(m.wd)}</button>` : ""}
      </div>`;
  }

  function repBadge(r) {
    const cls = r >= 7 ? "ok" : r >= 4 ? "info" : "bad";
    return `<span class="chip ${cls}">${r} / 10</span>`;
  }

  function spark(hist) {
    if (hist.length < 2) return "";
    const vals = hist.map((h) => Number(ethers.formatUnits(h.p, 8)));
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${36 - ((v - min) / span) * 32}`).join(" ");
    return `<svg viewBox="0 0 100 38" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#1f4fd8" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderOracle() {
    $("oraclePanel").innerHTML = S.commodities.map((c) => `
      <div class="feed">
        <div class="feed-top"><span class="feed-sym">${esc(c.symbol)}</span><span class="feed-price">${fmtPrice(c.price.p)}</span></div>
        <div class="feed-meta">ETH per unit · round ${c.price.id} · updated ${dur(now() - c.price.t)} ago</div>
        ${spark(c.hist)}
        <div class="btnrow">
          <button class="small" data-action="bump" data-c="${c.id}" data-pct="-10">−10%</button>
          <button class="small" data-action="bump" data-c="${c.id}" data-pct="-5">−5%</button>
          <button class="small" data-action="bump" data-c="${c.id}" data-pct="5">+5%</button>
          <button class="small" data-action="bump" data-c="${c.id}" data-pct="10">+10%</button>
        </div>
        <div class="btnrow">
          <input id="px${c.id}" type="text" placeholder="new price" />
          <button class="small" data-action="setPrice" data-c="${c.id}">Push price</button>
        </div>
      </div>`).join("");
    const sel = $("fCommodity");
    const keep = sel.value;
    sel.innerHTML = S.commodities.map((c) => `<option value="${c.id}">${esc(c.symbol)} · ${fmtPrice(c.price.p)} ETH</option>`).join("");
    if (keep) sel.value = keep;
  }

  function renderProto() {
    const cfg = C.config;
    $("protoPanel").innerHTML = `
      <div>CommSwap</div><div class="mono">${short(C.commSwap)}</div>
      <div>Registration fee</div><div class="mono">${fmtEth(cfg.registrationFee)}</div>
      <div>Grace period</div><div class="mono">${cfg.gracePeriod}s</div>
      <div>Min period</div><div class="mono">${cfg.minPeriod}s</div>
      <div>Selection window</div><div class="mono">${cfg.selectionWindow}s</div>
      <div>Insurance pool</div><div class="mono">${fmtEth(S.insurance)}</div>
      <div>Reputation</div><div>start 5 · +1 clean · −2 miss · =2 default</div>`;
  }

  function renderKPreview() {
    const c = S.commodities[Number($("fCommodity").value || 0)];
    if (!c) return;
    $("kPreview").innerHTML = `Reference price <b>K</b> will be snapshotted from the trusted <b>${esc(c.symbol)}</b> oracle when you submit: currently <b class="mono">${fmtPrice(c.price.p)} ETH/unit</b>. You cannot type K yourself.`;
  }

  function suggestCollateral() {
    const f = $("createForm");
    const c = S.commodities[Number(f.commodity.value)];
    const qty = Number(f.qty.value || 0);
    const win = Number(f.period.value);
    const h = c.hist.map((x) => ({ p: Number(ethers.formatUnits(x.p, 8)), t: x.t }));
    let maxMove = 0;
    for (let j = 1; j < h.length; j++) {
      // price one window before round j (last round at or before t_j - window), else previous round
      let base = h[j - 1].p;
      for (let k = j - 1; k >= 0; k--) if (h[k].t <= h[j].t - win) { base = h[k].p; break; }
      maxMove = Math.max(maxMove, Math.abs(h[j].p - base));
    }
    let note = "from oracle history";
    if (maxMove === 0) { maxMove = h[h.length - 1].p * 0.05; note = "no history yet, using 5% of spot"; }
    const coll = maxMove * qty * 3;
    f.coll.value = String(Math.round(coll * 1e4) / 1e4);
    $("suggestHint").textContent = `Collateral ref = max move ${maxMove.toFixed(4)} ETH (${note}) × qty ${qty} × threshold 3 = ${f.coll.value} ETH`;
  }

  function renderRequests() {
    const showClosed = $("showClosed").checked;
    // Always show closed proposals where the current user still has collateral to reclaim.
    const hasRefund = ({ r, acc }) => Number(r.status) !== 1 && acc.some((a) => isMe(a.acceptor) && !a.withdrawn);
    const list = S.requests.filter((x) => showClosed || Number(x.r.status) === 1 || hasRefund(x)).reverse();
    if (!list.length) { $("requests").innerHTML = `<div class="empty">No open proposals. Create one above.</div>`; return; }
    $("requests").innerHTML = list.map(({ id, r, acc }) => {
      const st = Number(r.status);
      const open = st === 1;
      const mine = isMe(r.creator);
      const acceptOpen = open && now() <= Number(r.acceptDeadline);
      const myAcc = acc.find((a) => isMe(a.acceptor));
      const best = acc.filter((a) => !a.withdrawn).reduce((b, a) => (S.repAll[a.acceptor.toLowerCase()] ?? 0) > (b ? S.repAll[b.acceptor.toLowerCase()] ?? 0 : -1) ? a : b, null);
      const swapOf = st === 2 ? S.swaps[Number(r.swapId)] : null;
      const selected = swapOf ? [swapOf.s.longParty, swapOf.s.shortParty].find((x) => x.toLowerCase() !== r.creator.toLowerCase()) : null;
      const rows = acc.map((a) => {
        const isSel = selected && a.acceptor.toLowerCase() === selected.toLowerCase();
        const state = isSel ? '<span class="chip ok">selected</span>' : a.withdrawn ? '<span class="chip">refunded</span>' : '<span class="chip info">waiting</span>';
        return `<tr class="${open && best && a === best ? "best" : ""}">
          <td><b>${nameOf(a.acceptor)}</b> <span class="mono" style="color:var(--muted)">${short(a.acceptor)}</span></td>
          <td class="num">${new Date(Number(a.acceptedAt) * 1000).toLocaleTimeString()}</td>
          <td>${a.reputationSnapshot} → ${repBadge(S.repAll[a.acceptor.toLowerCase()] ?? a.reputationSnapshot)}</td>
          <td>${state}</td>
          <td>${open && mine && !a.withdrawn ? `<button class="small primary" data-action="select" data-r="${id}" data-a="${a.acceptor}">Select</button>` : ""}</td>
        </tr>`;
      }).join("");
      const statusChip = st === 1 ? (acceptOpen ? '<span class="chip ok">open</span>' : '<span class="chip warn">accepting closed · awaiting selection</span>') : st === 2 ? `<span class="chip info">finalized → swap #${r.swapId}</span>` : '<span class="chip">cancelled</span>';
      return `<div class="item">
        <div class="item-h">
          <div class="item-title">Proposal #${id} · ${esc(sym(Number(r.commodityId)))} ${statusChip}</div>
          <div>by <b>${nameOf(r.creator)}</b> <span class="chip ${r.creatorIsLong ? "long" : "short"}">${r.creatorIsLong ? "LONG" : "SHORT"}</span></div>
        </div>
        <div class="facts">
          <span>K <b>${fmtPrice(r.refPrice)}</b></span>
          <span>Qty/period <b>${r.quantity}</b></span>
          <span>Collateral <b>${fmtEth(r.collateral)}</b></span>
          <span>Schedule <b>${r.numPeriods} × ${dur(Number(r.period))}</b></span>
          ${open ? `<span>Accept ${acceptOpen ? "closes in" : "closed"} ${acceptOpen ? countdown(Number(r.acceptDeadline)) : ""}</span><span>Select by ${countdown(Number(r.selectDeadline), "expired")}</span>` : ""}
        </div>
        ${acc.length ? `<table><thead><tr><th>Acceptor</th><th>Accepted</th><th>Rep snapshot → now</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No acceptors yet.</div>`}
        <div class="actions" style="margin-top:10px">
          ${acceptOpen && !mine && !myAcc && S.me.registered ? `<button class="primary" data-action="accept" data-r="${id}" data-v="${r.collateral}">Accept & lock ${fmtEth(r.collateral)}</button>` : ""}
          ${myAcc && !myAcc.withdrawn && !(selected && isMe(selected)) ? `<button class="${open ? "" : "good"}" data-action="unaccept" data-r="${id}">${open ? "Withdraw my acceptance" : `Claim refund ${fmtEth(r.collateral)}`}</button>` : ""}
          ${open && (mine || now() > Number(r.selectDeadline)) ? `<button data-action="cancel" data-r="${id}">${mine ? "Cancel proposal" : "Expire proposal"}</button>` : ""}
          ${open && mine && best ? `<span class="hint" style="margin:0">Highest current reputation: <b>${nameOf(best.acceptor)}</b></span>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  function partyBox(side, addr, ps, s, terminatedDefaulter) {
    const req = s.required;
    const maxv = [ps.collateral, req * 2n].reduce((a, b) => (a > b ? a : b));
    const pct = maxv ? Number((ps.collateral * 1000n) / maxv) / 10 : 0;
    const reqPct = maxv ? Number((req * 1000n) / maxv) / 10 : 0;
    const under = Number(s.status) === 1 && ps.collateral < req;
    const color = ps.shortfall > 0n ? "var(--bad)" : under ? "var(--warn)" : side === "long" ? "var(--long)" : "var(--short)";
    const dl = Number(ps.topUpDeadline);
    let flag = "";
    if (ps.shortfall > 0n) flag = '<span class="chip bad">shortfall owed</span>';
    else if (under) flag = '<span class="chip warn">under-collateralised</span>';
    if (ps.strike) flag += ' <span class="chip bad">−2 applied</span>';
    if (terminatedDefaulter) flag = '<span class="chip bad">defaulted</span>';
    return `<div class="party ${side}">
      <div class="who"><span>${side.toUpperCase()} · ${nameOf(addr)} ${isMe(addr) ? "(you)" : ""}</span><span>${repBadge(S.repAll[addr.toLowerCase()] ?? 0)}</span></div>
      <div class="bar"><i style="width:${pct}%;background:${color}"></i><span class="req" style="left:${reqPct}%"></span></div>
      <div class="line"><span>Locked collateral</span><span>${fmtEth(ps.collateral)}</span></div>
      <div class="line"><span>Required</span><span>${fmtEth(req)}</span></div>
      ${ps.shortfall > 0n ? `<div class="line"><span>Shortfall owed</span><span style="color:var(--bad)">${fmtEth(ps.shortfall)}</span></div>` : ""}
      ${dl ? `<div class="line"><span>Grace period ends</span><span>${countdown(dl, "expired")}</span></div>` : ""}
      <div style="margin-top:6px">${flag}</div>
    </div>`;
  }

  function renderSwaps() {
    if (!S.swaps.length) { $("swaps").innerHTML = `<div class="empty">No swaps yet. Select a counterparty on a proposal to start one.</div>`; return; }
    $("swaps").innerHTML = [...S.swaps].reverse().map(({ id, s, L, Sh }) => {
      const st = Number(s.status);
      const active = st === 1;
      const c = S.commodities[Number(s.commodityId)];
      const done = Number(s.roundsDone), n = Number(s.numPeriods);
      const nextT = Number(s.start) + (done + 1) * Number(s.period);
      const due = done < n;
      const graceRunning = [L, Sh].some((p) => Number(p.topUpDeadline) && now() <= Number(p.topUpDeadline));
      const canEnforce = active && [L, Sh].some((p) => Number(p.topUpDeadline) && now() > Number(p.topUpDeadline) && (p.shortfall > 0n || (p.collateral < s.required && !p.strike)));
      const myIdx = isMe(s.longParty) ? 0 : isMe(s.shortParty) ? 1 : -1;
      const mine = myIdx === 0 ? L : myIdx === 1 ? Sh : null;
      let need = 0n;
      if (mine) need = mine.shortfall + (mine.collateral < s.required ? s.required - mine.collateral : 0n);

      // payoff preview at current oracle price
      const diff = c.price.p - s.refPrice;
      const abs = diff < 0n ? -diff : diff;
      const amt = (abs * s.quantity * 10n ** 18n) / 10n ** 8n;
      const preview = diff === 0n ? "no payment" : `${diff > 0n ? "SHORT pays LONG" : "LONG pays SHORT"} <b class="mono">${fmtEth(amt)}</b>`;

      const hist = S.logs.filter((x) => x.ev.name === "Settled" && Number(x.ev.args.swapId) === id);
      const term = S.logs.find((x) => x.ev.name === "SwapTerminated" && Number(x.ev.args.swapId) === id);
      const defaulter = term ? term.ev.args.defaulter : null;
      const chip = st === 1 ? '<span class="chip ok">active</span>' : st === 2 ? '<span class="chip info">matured</span>' : '<span class="chip bad">terminated (default)</span>';
      const rows = hist.map(({ ev }) => {
        const a = ev.args;
        const w = a.winner === ethers.ZeroAddress ? "—" : nameOf(a.winner);
        const partial = a.amountPaid < a.amountDue;
        return `<tr><td class="num">${a.round}</td><td class="num">${fmtPrice(a.price)}</td><td class="num" style="color:${a.priceDiff > 0n ? "var(--long)" : a.priceDiff < 0n ? "var(--short)" : "inherit"}">${a.priceDiff > 0n ? "+" : ""}${fmtPrice(a.priceDiff)}</td><td class="num">${fmtEth(a.amountDue)}</td><td class="num">${fmtEth(a.amountPaid)}${partial ? ' <span class="chip bad">partial</span>' : ""}</td><td>${w}</td></tr>`;
      }).join("");

      return `<div class="item">
        <div class="item-h">
          <div class="item-title">Swap #${id} · ${esc(c.symbol)} ${chip}</div>
          <div class="mono">round ${done} / ${n}</div>
        </div>
        <div class="facts">
          <span>K <b>${fmtPrice(s.refPrice)}</b></span>
          <span>Oracle now <b>${fmtPrice(c.price.p)}</b></span>
          <span>Qty/period <b>${s.quantity}</b></span>
          <span>Period <b>${dur(Number(s.period))}</b></span>
          ${active && due ? `<span>Next settlement ${countdown(nextT, "due now")}</span>` : ""}
          <span>from proposal #${s.requestId}</span>
        </div>
        ${active && due ? `<div class="preview">If the oracle stays at ${fmtPrice(c.price.p)} until the scheduled time: (P − K) × Q → ${preview}</div>` : ""}
        <div class="parties">
          ${partyBox("long", s.longParty, L, s, defaulter && defaulter.toLowerCase() === s.longParty.toLowerCase())}
          ${partyBox("short", s.shortParty, Sh, s, defaulter && defaulter.toLowerCase() === s.shortParty.toLowerCase())}
        </div>
        ${term ? `<div class="banner">Terminated: ${defaulter === ethers.ZeroAddress ? "both parties defaulted" : `${nameOf(defaulter)} defaulted, ${fmtEth(term.ev.args.slashed)} slashed to counterparty, ${fmtEth(term.ev.args.insurancePaid)} paid from insurance pool`}.</div>` : ""}
        ${rows ? `<table style="margin:8px 0"><thead><tr><th>Round</th><th>Price at schedule</th><th>P − K</th><th>Due</th><th>Paid</th><th>Winner</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
        <div class="actions">
          ${active && due ? `<button class="primary" data-action="settle" data-s="${id}" ${now() < nextT || graceRunning ? "disabled" : ""}>Settle round ${done + 1}</button>
            <button data-action="jump" data-t="${nextT}" ${now() >= nextT ? "disabled" : ""}>⏩ Jump to settlement time</button>` : ""}
          ${active && graceRunning ? `<span class="hint" style="margin:0">Settlement waits for the grace period (price is already pinned to the scheduled time).</span>` : ""}
          ${active && mine ? `<input id="tu${id}" type="text" value="${need > 0n ? ethers.formatEther(need) : ""}" placeholder="ETH" /><button class="good" data-action="topup" data-s="${id}">Top up</button>` : ""}
          ${canEnforce ? `<button class="danger" data-action="enforce" data-s="${id}">Enforce (grace expired)</button>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  function describe({ ev }) {
    const a = ev.args;
    switch (ev.name) {
      case "Registered": return [nameOf(a.user), `registered, paid ${fmtEth(a.fee)}, reputation ${a.reputation}`];
      case "CommodityAdded": return ["Oracle Admin", `added ${a.symbol} feed ${short(a.feed)}`];
      case "RequestCreated": return [nameOf(a.creator), `proposal #${a.requestId}: ${sym(Number(a.commodityId))} × ${a.quantity}, ${a.creatorIsLong ? "LONG" : "SHORT"}, K = ${fmtPrice(a.refPrice)} (oracle), collateral ${fmtEth(a.collateral)}`];
      case "RequestAccepted": return [nameOf(a.acceptor), `accepted proposal #${a.requestId} (rep ${a.reputation}), locked collateral`];
      case "AcceptanceWithdrawn": return [nameOf(a.acceptor), `refund credited for proposal #${a.requestId}`];
      case "RequestCancelled": return ["—", `proposal #${a.requestId} cancelled, creator collateral credited`];
      case "SwapStarted": return [nameOf(a.longParty), `swap #${a.swapId} started: LONG ${nameOf(a.longParty)} vs SHORT ${nameOf(a.shortParty)}`];
      case "Settled": return ["Settlement", `swap #${a.swapId} round ${a.round}: price ${fmtPrice(a.price)}, due ${fmtEth(a.amountDue)}, paid ${fmtEth(a.amountPaid)} → ${nameOf(a.winner)}`];
      case "MarginCall": return [nameOf(a.party), `margin call on swap #${a.swapId}: collateral ${fmtEth(a.collateral)} / ${fmtEth(a.required)}${a.shortfall > 0n ? `, shortfall ${fmtEth(a.shortfall)}` : ""}`];
      case "ToppedUp": return [nameOf(a.party), `topped up ${fmtEth(a.amount)} on swap #${a.swapId}${a.shortfallPaid > 0n ? ` (${fmtEth(a.shortfallPaid)} cleared shortfall)` : ""}`];
      case "MissedTopUp": return [nameOf(a.party), `missed top-up on swap #${a.swapId}`];
      case "ReputationChanged": return [nameOf(a.user), `reputation ${a.oldRep} → ${a.newRep} (${a.reason})`];
      case "SwapMatured": return ["Settlement", `swap #${a.swapId} matured: LONG gets ${fmtEth(a.longPayout)}, SHORT gets ${fmtEth(a.shortPayout)}`];
      case "SwapTerminated": return [nameOf(a.defaulter), `swap #${a.swapId} TERMINATED: slashed ${fmtEth(a.slashed)}, insurance paid ${fmtEth(a.insurancePaid)}`];
      case "Withdrawn": return [nameOf(a.user), `withdrew ${fmtEth(a.amount)}`];
      default: return ["—", ev.name];
    }
  }

  function renderActivity() {
    if (!S.logs.length) { $("activity").innerHTML = `<div class="empty">No events yet.</div>`; return; }
    $("activity").innerHTML = [...S.logs].reverse().map((x) => {
      const [who, what] = describe(x);
      return `<div class="ev"><span class="blk">#${x.l.blockNumber}</span><span class="name">${esc(who)}</span><span>${esc(what)}</span></div>`;
    }).join("");
  }

  function tick() {
    const t = now();
    $("chainClock").textContent = "chain time " + new Date(t * 1000).toLocaleTimeString();
    document.querySelectorAll(".cd").forEach((el) => {
      const left = Number(el.dataset.ts) - t;
      el.textContent = left > 0 ? "in " + dur(left) : el.dataset.done;
      el.style.color = left > 0 ? "" : "var(--warn)";
    });
  }

  // ------------------------------------------------------------ actions
  async function warp(sec) {
    await provider.send("evm_increaseTime", [Math.floor(sec)]);
    await provider.send("evm_mine", []);
    toast(`⏩ chain time +${dur(sec)}`);
    await refresh();
  }

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b || b.disabled) return;
    const d = b.dataset;
    const act = d.action;
    try {
      if (act === "register") return send("Register", async () => (await asMe()).register({ value: C.config.registrationFee }));
      if (act === "withdraw") return send("Withdraw", async () => (await asMe()).withdraw());
      if (act === "accept") return send(`Accept #${d.r}`, async () => (await asMe()).acceptRequest(d.r, { value: BigInt(d.v) }));
      if (act === "unaccept") return send(`Withdraw acceptance #${d.r}`, async () => (await asMe()).withdrawAcceptance(d.r));
      if (act === "cancel") return send(`Cancel #${d.r}`, async () => (await asMe()).cancelRequest(d.r));
      if (act === "select") return send(`Select ${nameOf(d.a)}`, async () => (await asMe()).selectCounterparty(d.r, d.a));
      if (act === "settle") return send(`Settle swap #${d.s}`, async () => (await asMe()).settle(d.s, 0));
      if (act === "enforce") return send(`Enforce swap #${d.s}`, async () => (await asMe()).enforce(d.s));
      if (act === "topup") {
        const v = $(`tu${d.s}`).value.trim();
        if (!v || Number(v) <= 0) return toast("Enter an ETH amount", "err");
        return send(`Top up ${v} ETH`, async () => (await asMe()).topUp(d.s, { value: ethers.parseEther(v) }));
      }
      if (act === "setPrice" || act === "bump") {
        const c = S.commodities[Number(d.c)];
        let newP;
        if (act === "bump") newP = (c.price.p * BigInt(100 + Number(d.pct))) / 100n;
        else {
          const v = $(`px${d.c}`).value.trim();
          if (!v || Number(v) <= 0) return toast("Enter a positive price", "err");
          newP = P(v);
        }
        return send(`${c.symbol} → ${fmtPrice(newP)}`, async () => new ethers.Contract(c.feed, C.abi.Feed, await signer(0)).updateAnswer(newP));
      }
      if (act === "warp") return warp(Number(d.sec));
      if (act === "warpCustom") { const v = Number($("warpCustom").value); if (v > 0) return warp(v); return; }
      if (act === "jump") { const left = Number(d.t) - now() + 2; if (left > 0) return warp(left); return; }
      if (act === "suggest") return suggestCollateral();
    } catch (err) {
      toast(errMsg(err), "err");
    }
  });

  $("createForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    let coll;
    try { coll = ethers.parseEther(f.coll.value.trim()); } catch (_) { return toast("Bad collateral amount", "err"); }
    send("Create proposal", async () =>
      (await asMe()).createRequest(Number(f.commodity.value), BigInt(f.qty.value), f.side.value === "long", BigInt(f.period.value), Number(f.n.value), BigInt(f.win.value), { value: coll })
    );
  });
  $("fCommodity").addEventListener("change", renderKPreview);
  $("showClosed").addEventListener("change", renderRequests);
  $("acctSelect").addEventListener("change", (e) => { S.current = Number(e.target.value); refresh(); });

  // ------------------------------------------------------------ boot
  (async function boot() {
    try {
      S.accounts = (await provider.send("eth_accounts", [])).map((a) => ethers.getAddress(a));
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== C.chainId) toast(`Unexpected chainId ${net.chainId}`, "err");
      const code = await provider.getCode(C.commSwap);
      if (code === "0x") {
        toast("CommSwap not found on this node. Re-run the deploy script (the node was probably restarted).", "err");
      }
    } catch (e) {
      $("netStatus").textContent = "● node not reachable: run `npx hardhat node`";
      $("netStatus").className = "pill err";
      return setTimeout(boot, 2000);
    }
    $("acctSelect").innerHTML = S.accounts.slice(0, 8).map((a, i) => `<option value="${i}" ${i === S.current ? "selected" : ""}>${NAMES[i]} · ${short(a)}</option>`).join("");
    await refresh();
    setInterval(tick, 1000);
    setInterval(() => {
      const ae = document.activeElement;
      const typing = ae && ae.matches && ae.matches("input, select") && ae.closest("#oraclePanel, #swaps, #requests");
      if (!S.busy && !typing) refresh();
    }, 4000);
  })();
})();
