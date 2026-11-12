(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DAY = 864e5;
  const PAGE_PRS = 40;
  const PAGE_PROJECTS = 12;
  const TOP_PROJECTS = 10;

  const $ = (sel) => document.querySelector(sel);

  // Build DOM nodes without innerHTML: titles and descriptions come from the API.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  const fmtDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const fmtDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
  const fmtMonth = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
  const fmtMonthShort = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
  const fmtUpdated = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
  const fmtInt = new Intl.NumberFormat("en");
  const fmtCompact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const plural = (n, one, many) => `${fmtInt.format(n)} ${n === 1 ? one : many}`;

  // ---------- theme ----------
  const toggle = $("#theme-toggle");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");
  function labelToggle() {
    toggle.setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  toggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* private mode */ }
    labelToggle();
  });
  labelToggle();

  // ---------- tooltip ----------
  const tip = $("#tooltip");
  function showTip(value, label, x, y) {
    tip.replaceChildren(el("strong", null, value), el("span", null, label));
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, x - w / 2), document.documentElement.clientWidth - w - 8);
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${y - h - 12 + window.scrollY}px`;
  }
  function hideTip() { tip.hidden = true; }

  // ---------- data ----------
  let DATA, merged, open, repos, repoStats;
  const state = { q: "", repo: "", status: "all", limit: PAGE_PRS, projectsAll: false };

  fetch("data/contributions.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch((err) => { console.error(err); $("#load-error").hidden = false; });

  function init(data) {
    DATA = data;
    repos = new Map(data.repos.map((r) => [r.name, r]));
    merged = data.prs.filter((p) => p.status === "merged");
    open = data.prs.filter((p) => p.status === "open");
    repoStats = new Map();
    for (const p of data.prs) {
      const s = repoStats.get(p.repo) || { merged: 0, open: 0 };
      s[p.status] += 1;
      repoStats.set(p.repo, s);
    }

    const params = new URLSearchParams(location.search);
    if (repos.has(params.get("repo"))) state.repo = params.get("repo");
    if (["merged", "open"].includes(params.get("status"))) state.status = params.get("status");
    state.q = params.get("q") || "";

    if (data.searchUrl) $("#search-link").href = data.searchUrl;
    const updated = new Date(data.updatedAt);
    $("#updated").dateTime = data.updatedAt;
    $("#updated").textContent = fmtUpdated.format(updated);

    renderStats();
    renderTimeChart();
    renderProjectChart();
    renderProjects();
    setupFilters();
    renderPRs();

    let lastWidth = $("#chart-time").clientWidth;
    new ResizeObserver(() => {
      const w = $("#chart-time").clientWidth;
      if (w !== lastWidth) { lastWidth = w; renderTimeChart(); }
    }).observe($("#chart-time"));
  }

  function mergedRepoNames() {
    return [...repoStats.entries()].filter(([, s]) => s.merged > 0).map(([name]) => name);
  }

  // ---------- stats ----------
  function renderStats() {
    const names = mergedRepoNames();
    const owners = new Set(names.map((n) => repos.get(n).owner));
    const stars = names.reduce((sum, n) => sum + repos.get(n).stars, 0);
    $("#s-merged").textContent = fmtInt.format(merged.length);
    $("#s-projects").textContent = fmtInt.format(names.length);
    $("#s-orgs").textContent = fmtInt.format(owners.size);
    $("#s-open").textContent = fmtInt.format(open.length);
    $("#s-stars").textContent = fmtCompact.format(stars);
    if (merged.length) {
      const first = merged.reduce((a, p) => (p.mergedAt < a ? p.mergedAt : a), merged[0].mergedAt);
      $("#s-since").textContent = `since ${fmtMonth.format(new Date(first))}`;
    }
  }

  // ---------- merged over time (columns) ----------
  function weekStart(t) {
    const d = new Date(t);
    const back = (d.getUTCDay() + 6) % 7; // Monday-based weeks
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
  }
  function monthStart(t) {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  function timeBuckets() {
    if (!merged.length) return { unit: "week", buckets: [] };
    const times = merged.map((p) => Date.parse(p.mergedAt));
    const first = Math.min(...times);
    const now = Date.now();
    const weeks = Math.round((weekStart(now) - weekStart(first)) / (7 * DAY)) + 1;
    const unit = weeks > 26 ? "month" : "week";
    const keyOf = unit === "week" ? weekStart : monthStart;
    const counts = new Map();
    for (const t of times) counts.set(keyOf(t), (counts.get(keyOf(t)) || 0) + 1);
    const buckets = [];
    for (let k = keyOf(first); k <= keyOf(now);) {
      buckets.push({ t: k, n: counts.get(k) || 0 });
      if (unit === "week") k += 7 * DAY;
      else { const d = new Date(k); k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
    }
    return { unit, buckets };
  }

  function niceStep(max) {
    const target = Math.max(max, 1) / 4;
    const pow = 10 ** Math.floor(Math.log10(target));
    for (const m of [1, 2, 2.5, 5, 10]) {
      const step = m * pow;
      if (step >= target && Number.isInteger(step)) return step;
    }
    return 10 * pow;
  }

  function columnPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
  }

  function renderTimeChart() {
    const { unit, buckets } = timeBuckets();
    const host = $("#chart-time");
    const labelOf = (t) => (unit === "week" ? `Week of ${fmtDate.format(new Date(t))}` : fmtMonth.format(new Date(t)));
    const tickOf = (t) => (unit === "week" ? fmtDay.format(new Date(t)) : fmtMonthShort.format(new Date(t)));

    $("#time-title").textContent = unit === "week" ? "Merged per week" : "Merged per month";
    $("#time-col").textContent = unit === "week" ? "Week of" : "Month";
    const peak = buckets.reduce((a, b) => (b.n > a.n ? b : a), { n: 0 });
    $("#time-sub").textContent = peak.n
      ? `Busiest ${unit}: ${plural(peak.n, "PR", "PRs")}, ${unit === "week" ? "week of " + fmtDay.format(new Date(peak.t)) : fmtMonth.format(new Date(peak.t))}`
      : "";

    const tbody = $("#table-time tbody");
    tbody.replaceChildren(...buckets.slice().reverse().map((b) =>
      el("tr", null, el("td", null, unit === "week" ? fmtDate.format(new Date(b.t)) : fmtMonth.format(new Date(b.t))), el("td", { class: "num" }, b.n))));

    const W = host.clientWidth || 600;
    const H = window.innerWidth > 900 ? 310 : 230;
    const m = { top: 22, right: 4, bottom: 26, left: 30 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const max = Math.max(1, ...buckets.map((b) => b.n));
    const step = niceStep(max);
    const yMax = Math.ceil(max / step) * step;
    const y = (v) => m.top + ph - (v / yMax) * ph;
    const band = pw / Math.max(1, buckets.length);
    const colW = Math.max(2, Math.min(24, band * 0.62));

    const root = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `${unit === "week" ? "Weekly" : "Monthly"} merged pull requests, ${buckets.length} ${unit}s. Peak ${peak.n}.` });

    for (let v = 0; v <= yMax; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      root.append(svg("line", { class: v === 0 ? "baseline" : "gridline", x1: m.left, x2: W - m.right, y1: yy, y2: yy }));
      const t = svg("text", { class: "tick", x: m.left - 8, y: yy + 4, "text-anchor": "end" });
      t.textContent = fmtInt.format(v);
      root.append(t);
    }

    // Label every k-th bucket so ticks never collide; always keep the latest.
    const every = Math.max(1, Math.ceil(46 / band));
    const last = buckets.length - 1;
    const capIdx = new Set();
    const peakIdx = buckets.findIndex((b) => b === peak);
    if (peakIdx >= 0 && peak.n > 0) capIdx.add(peakIdx);
    if (last >= 0 && buckets[last].n > 0) capIdx.add(last);

    const marks = [];
    buckets.forEach((b, i) => {
      const cx = m.left + band * i + band / 2;
      if ((last - i) % every === 0) {
        const t = svg("text", { class: "tick", x: cx, y: H - 8, "text-anchor": "middle" });
        t.textContent = tickOf(b.t);
        root.append(t);
      }
      let col = null;
      if (b.n > 0) {
        const top = y(b.n);
        col = svg("path", { class: "col", d: columnPath(cx - colW / 2, top, colW, m.top + ph - top, 4) });
        root.append(col);
        if (capIdx.has(i)) {
          const t = svg("text", { class: "cap", x: cx, y: top - 6, "text-anchor": "middle" });
          t.textContent = fmtInt.format(b.n);
          root.append(t);
        }
      }
      const hit = svg("rect", { class: "hit", x: m.left + band * i, y: m.top, width: band, height: ph,
        tabindex: 0, role: "img", "aria-label": `${labelOf(b.t)}: ${plural(b.n, "merged pull request", "merged pull requests")}` });
      marks.push({ hit, col, b });
      root.append(hit);
    });

    const setActive = (mark, x, yy) => {
      host.classList.add("hovering");
      for (const k of marks) if (k.col) k.col.classList.toggle("is-active", k === mark);
      showTip(plural(mark.b.n, "merged", "merged"), labelOf(mark.b.t), x, yy);
    };
    const clear = () => { host.classList.remove("hovering"); hideTip(); };
    for (const mark of marks) {
      mark.hit.addEventListener("pointermove", (e) => setActive(mark, e.clientX, e.clientY));
      mark.hit.addEventListener("pointerleave", clear);
      mark.hit.addEventListener("focus", () => {
        const r = (mark.col || mark.hit).getBoundingClientRect();
        setActive(mark, r.left + r.width / 2, r.top);
      });
      mark.hit.addEventListener("blur", clear);
    }
    host.replaceChildren(root);
  }

  // ---------- merged by project (bars) ----------
  function repoLabel(name) {
    const [owner, repo] = name.split("/");
    return [el("span", null, `${owner}/`), el("b", null, repo)];
  }

  function renderProjectChart() {
    const rows = mergedRepoNames()
      .map((name) => ({ name, n: repoStats.get(name).merged }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const top = rows.slice(0, TOP_PROJECTS);
    const rest = rows.slice(TOP_PROJECTS);
    const max = Math.max(1, ...rows.map((r) => r.n), rest.reduce((s, r) => s + r.n, 0));

    const bar = (n, labelNodes, tipLabel, attrs, isButton) => {
      const node = el(isButton ? "button" : "div", { class: "hbar", ...attrs },
        el("span", { class: "hbar-label" }, labelNodes),
        el("span", { class: "hbar-track" },
          el("span", { class: "hbar-bar", style: `width: calc((100% - 4ch) * ${(n / max).toFixed(4)})` }),
          el("span", { class: "hbar-value" }, fmtInt.format(n))));
      const show = (x, y) => showTip(plural(n, "merged", "merged"), tipLabel, x, y);
      node.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
      node.addEventListener("pointerleave", hideTip);
      node.addEventListener("focus", () => { const r = node.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
      node.addEventListener("blur", hideTip);
      return node;
    };

    const nodes = top.map((r) => bar(r.n, repoLabel(r.name), r.name, {
      type: "button", "aria-label": `${r.name}: ${plural(r.n, "merged pull request", "merged pull requests")}. Show its pull requests.`,
      onclick: () => filterToRepo(r.name),
    }, true));
    if (rest.length) {
      const n = rest.reduce((s, r) => s + r.n, 0);
      const label = `Other (${plural(rest.length, "project", "projects")})`;
      nodes.push(bar(n, label, label, { class: "hbar other", tabindex: 0, role: "img",
        "aria-label": `${label}: ${plural(n, "merged pull request", "merged pull requests")}` }, false));
    }
    $("#chart-projects").replaceChildren(...nodes);

    const all = [...repoStats.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.merged - a.merged || b.open - a.open || a.name.localeCompare(b.name));
    $("#table-projects tbody").replaceChildren(...all.map((r) =>
      el("tr", null, el("td", null, r.name), el("td", { class: "num" }, r.merged), el("td", { class: "num" }, r.open))));
  }

  // ---------- project cards ----------
  function avatar(url, size) {
    const src = url + (url.includes("?") ? "&" : "?") + `s=${size * 2}`;
    return el("img", { class: "avatar", src, alt: "", width: size, height: size, loading: "lazy", decoding: "async" });
  }

  function renderProjects() {
    const names = mergedRepoNames().sort((a, b) =>
      repoStats.get(b).merged - repoStats.get(a).merged || repos.get(b).stars - repos.get(a).stars);
    const shown = state.projectsAll ? names : names.slice(0, PAGE_PROJECTS);
    $("#project-grid").replaceChildren(...shown.map((name) => {
      const r = repos.get(name);
      const s = repoStats.get(name);
      const [owner, repo] = name.split("/");
      return el("article", { class: "card proj" },
        el("div", { class: "proj-head" },
          avatar(r.avatar, 28),
          el("a", { class: "proj-name", href: r.url }, el("span", { class: "owner" }, `${owner}/`), el("b", null, repo))),
        el("p", { class: "proj-desc" }, r.description || "No description"),
        el("div", { class: "proj-meta" },
          el("span", { "aria-label": `${fmtInt.format(r.stars)} stars` }, "★ ", fmtCompact.format(r.stars)),
          r.language && el("span", null,
            el("i", { class: "lang-dot", style: `background:${/^#[0-9a-f]{3,8}$/i.test(r.languageColor || "") ? r.languageColor : "var(--muted)"}` }),
            r.language)),
        el("button", { type: "button", class: "proj-prs", onclick: () => filterToRepo(name) },
          el("b", null, fmtInt.format(s.merged)), " merged",
          s.open ? ` · ${fmtInt.format(s.open)} in review` : ""));
    }));
    const more = $("#projects-more");
    more.hidden = names.length <= PAGE_PROJECTS;
    more.textContent = state.projectsAll ? "Show fewer projects" : `Show all ${names.length} projects`;
    more.onclick = () => { state.projectsAll = !state.projectsAll; renderProjects(); };
  }

  // ---------- PR list ----------
  function setupFilters() {
    const select = $("#f-repo");
    const options = [...repoStats.entries()]
      .sort((a, b) => (b[1].merged + b[1].open) - (a[1].merged + a[1].open) || a[0].localeCompare(b[0]))
      .map(([name, s]) => el("option", { value: name }, `${name} (${s.merged + s.open})`));
    select.append(...options);
    select.value = state.repo;
    $("#f-status").value = state.status;
    $("#f-q").value = state.q;

    let timer;
    $("#f-q").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value; state.limit = PAGE_PRS; syncURL(); renderPRs(); }, 120);
    });
    select.addEventListener("change", (e) => { state.repo = e.target.value; state.limit = PAGE_PRS; syncURL(); renderPRs(); });
    $("#f-status").addEventListener("change", (e) => { state.status = e.target.value; state.limit = PAGE_PRS; syncURL(); renderPRs(); });
    $("#prs-more").addEventListener("click", () => { state.limit = Infinity; renderPRs(); });
  }

  function filterToRepo(name) {
    state.repo = name;
    state.limit = PAGE_PRS;
    $("#f-repo").value = name;
    syncURL();
    renderPRs();
    $("#prs").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function syncURL() {
    const p = new URLSearchParams();
    if (state.repo) p.set("repo", state.repo);
    if (state.status !== "all") p.set("status", state.status);
    if (state.q.trim()) p.set("q", state.q.trim());
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}#prs` : location.pathname);
  }

  function statusBadge(status) {
    const icon = svg("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", "stroke-width": 2.2, "stroke-linecap": "round", "aria-hidden": "true" });
    if (status === "merged") icon.append(svg("path", { d: "M5 12.5l4.5 4.5L19 7.5" }));
    else icon.append(svg("circle", { cx: 12, cy: 12, r: 7 }));
    return el("span", { class: `status ${status}` }, icon, status === "merged" ? "Merged" : "In review");
  }

  function renderPRs() {
    const q = state.q.trim().toLowerCase();
    const list = DATA.prs.filter((p) =>
      (state.status === "all" || p.status === state.status) &&
      (!state.repo || p.repo === state.repo) &&
      (!q || p.title.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q)));
    const shown = list.slice(0, state.limit);

    $("#pr-count").textContent = list.length === shown.length
      ? plural(list.length, "pull request", "pull requests")
      : `Showing ${fmtInt.format(shown.length)} of ${plural(list.length, "pull request", "pull requests")}`;

    const items = shown.map((p) => {
      const r = repos.get(p.repo);
      const when = p.status === "merged" ? `Merged ${fmtDate.format(new Date(p.mergedAt))}` : `Opened ${fmtDate.format(new Date(p.createdAt))}`;
      return el("li", { class: "pr" },
        avatar(r.avatar, 20),
        el("div", null,
          el("a", { class: "pr-title", href: p.url }, p.title),
          el("div", { class: "pr-meta" },
            el("span", null, `${p.repo} #${p.number}`),
            el("span", null, when),
            el("span", { class: "diff", "aria-label": `${p.additions} lines added, ${p.deletions} removed` },
              `+${fmtInt.format(p.additions)} −${fmtInt.format(p.deletions)}`))),
        statusBadge(p.status));
    });
    $("#pr-list").replaceChildren(...(items.length ? items : [el("li", { class: "empty" }, "No pull requests match these filters.")]));

    const more = $("#prs-more");
    more.hidden = list.length <= shown.length;
    more.textContent = `Show all ${fmtInt.format(list.length)}`;
  }

})();
