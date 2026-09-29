import {
  MIN, DAY_NAMES, DAY_SHORT, browserTz, allTimeZones, isValidTz, zoned, zonedToUtc, addDays, ymdKey, parseYmd,
  weekStart, fmtTime, fmtDate, fmtDateTime, fmtMinutes, tzLabel, shortTz, offsetMin,
} from './tz.js';
import { ProjectStore, newProjectKey, normalizeKey, newId, local } from './store.js';
import { inviteUrl, siteBase } from './invite-data.js';
import { tzPicker } from './tzpicker.js';

const SLOT = 30; // minutes per calendar row
const SLOTS = (24 * 60) / SLOT;
const DAY = 24 * 60 * MIN;
const COLORS = ['#4f46e5', '#e11d48', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#ea580c', '#2563eb', '#65a30d', '#9333ea', '#0d9488'];
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first

const $top = document.getElementById('topbar');
const $main = document.getElementById('main');
const $modals = document.getElementById('modals');

let store = null;
let S = null; // latest project state
let projectKey = null;
let weekOffset = 0;
let openedAt = 0;
let scrollMemo = null;
let unsub = null;

// ---- tiny DOM helper ---------------------------------------------------------------------------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function copy(text, msg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function avatar(m, size = 30) {
  return h('span', { class: 'avatar', style: { background: m.color || COLORS[0], width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } }, initials(m.name));
}

// ---- modal -------------------------------------------------------------------------------------

function modal(content, { wide = false, onClose } = {}) {
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'modal-back' }, box);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && back === $modals.lastElementChild) close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  $modals.append(back);
  const first = box.querySelector('input:not([type=checkbox]), textarea');
  if (first && !('ontouchstart' in window)) setTimeout(() => first.focus(), 30);
  return close;
}

function modalHead(title, close, sub) {
  return h('div', { class: 'modal-head' },
    h('div', { class: 'grow' }, h('h2', {}, title), sub ? h('div', { class: 'muted small', style: { marginTop: '4px' } }, sub) : null),
    h('button', { class: 'ghost icon', 'aria-label': 'Close', onclick: close }, '✕'));
}

function tzSelect(value) {
  return tzPicker(value);
}

// ---- recent projects ---------------------------------------------------------------------------

function recent() { return local.get('ms:recent', []); }
function remember(key, name) {
  const list = recent().filter((r) => r.key !== key);
  list.unshift({ key, name: name || key, t: Date.now() });
  local.set('ms:recent', list.slice(0, 20));
}
function forget(key) {
  local.set('ms:recent', recent().filter((r) => r.key !== key));
  local.del(`ms:cache:${key}`);
  local.del(`ms:me:${key}`);
  local.del(`ms:hidden:${key}`);
}

// ---- routing -----------------------------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/p\/([a-z0-9-]+)/i);
  const key = m && normalizeKey(m[1]);
  if (key) {
    if (key !== projectKey) openProject(key);
  } else {
    closeProject();
    renderHome();
  }
}
window.addEventListener('hashchange', route);

function closeProject() {
  if (unsub) unsub();
  if (store) store.close();
  store = null; S = null; projectKey = null; unsub = null;
  $modals.innerHTML = '';
}

// ---- home --------------------------------------------------------------------------------------

function brand() {
  return h('a', { class: 'brand', href: '#/', 'aria-label': 'MeetSync home' }, h('span', { class: 'logo' }, 'M'), h('span', { class: 'brand-name' }, 'MeetSync'));
}

function renderHome() {
  document.title = 'MeetSync · find a time that works for everyone';
  $top.replaceChildren(brand());

  const nameIn = h('input', { placeholder: 'Project name, e.g. Website relaunch', maxlength: '80', 'aria-label': 'Project name' });
  const createErr = h('div', { class: 'error' });
  const create = async (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) { createErr.textContent = 'Give your project a name.'; nameIn.focus(); return; }
    const key = newProjectKey();
    const s = new ProjectStore(key);
    await s.open();
    s.put('meta', { name, created: Date.now() });
    remember(key, name);
    handoff = s;
    location.hash = `#/p/${key}`;
  };

  const keyIn = h('input', { placeholder: 'xxxx-xxxx-xxxx', class: 'mono', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Project key' });
  const joinErr = h('div', { class: 'error' });
  const join = (e) => {
    e.preventDefault();
    const raw = keyIn.value.trim();
    const fromLink = raw.match(/#\/p\/([a-z0-9-]+)/i);
    const key = normalizeKey(fromLink ? fromLink[1] : raw);
    if (!key) { joinErr.textContent = 'That doesn\'t look like a project key. It has 12 letters and numbers, like abcd-efgh-2345.'; return; }
    location.hash = `#/p/${key}`;
  };

  const rec = recent();
  $main.replaceChildren(...[
    h('section', { class: 'hero' },
      h('h1', {}, 'Find a time that works for everyone'),
      h('p', { class: 'muted' }, 'Share one key with your project team. Everyone adds their hours, you see the overlap in your own time zone, and send invites that drop into any calendar. Free, no sign-up.')),
    h('div', { class: 'home-grid' },
      h('form', { class: 'card stack', onsubmit: create },
        h('h2', {}, 'Create a project'),
        h('p', { class: 'muted small', style: { margin: '0' } }, 'You\'ll get a key to share with your team.'),
        nameIn, createErr,
        h('button', { class: 'primary', type: 'submit', style: { width: '100%' } }, 'Create project')),
      h('form', { class: 'card stack', onsubmit: join },
        h('h2', {}, 'Join a project'),
        h('p', { class: 'muted small', style: { margin: '0' } }, 'Paste the key (or link) someone shared with you.'),
        keyIn, joinErr,
        h('button', { type: 'submit', style: { width: '100%' } }, 'Join project'))),
    rec.length ? h('section', { class: 'recent card' },
      h('h3', { style: { marginBottom: '8px' } }, 'Your projects on this device'),
      rec.map((r) => h('div', { class: 'recent-item' },
        h('a', { href: `#/p/${r.key}` }, r.name),
        h('span', { class: 'mono muted small' }, r.key),
        h('button', {
          class: 'ghost sm', title: 'Remove from this list', onclick: () => {
            if (confirm(`Remove "${r.name}" from this device? The project itself is not deleted.`)) { forget(r.key); renderHome(); }
          },
        }, 'Remove')))) : null,
    h('section', { class: 'how' },
      h('div', {}, h('b', {}, '1. Share the key'), 'Anyone with the key can join and edit. No accounts, no roles.'),
      h('div', {}, h('b', {}, '2. Add your hours'), 'Pick your time zone and paint your weekly availability.'),
      h('div', {}, h('b', {}, '3. Book the overlap'), 'Green means everyone is free. Create a meeting and share the invite link.')),
    h('footer', { class: 'site' }, 'Project data is end-to-end encrypted with your project key.')].filter(Boolean));
}

let handoff = null; // store created on the home page, reused when navigating into the project

// ---- project -----------------------------------------------------------------------------------

async function openProject(key) {
  closeProject();
  projectKey = key;
  weekOffset = 0;
  scrollMemo = null;
  openedAt = Date.now();
  S = null;
  $top.replaceChildren(brand());
  $main.replaceChildren(h('div', { class: 'hero' }, h('h2', {}, 'Opening project…')));
  const s = handoff && handoff.key === key ? handoff : await new ProjectStore(key).open();
  handoff = null;
  if (projectKey !== key) { s.close(); return; }
  store = s;
  unsub = store.subscribe((state) => { S = state; renderProject(); });
  S = store.state();
  renderProject();
  // Re-check "not found" once relays had a chance to answer.
  setTimeout(() => { if (store === s) renderProject(); }, 5000);
  setTimeout(() => { if (store === s) renderProject(); }, 12000);
}

const meId = () => local.get(`ms:me:${projectKey}`, null);
const setMe = (id) => local.set(`ms:me:${projectKey}`, id);
const me = () => (S && S.members[meId()]) || null;
const viewTz = () => (me() && isValidTz(me().tz) ? me().tz : browserTz());
const hidden = () => new Set(local.get(`ms:hidden:${projectKey}`, []));
const members = () => Object.values(S.members).sort((a, b) => (a.created || 0) - (b.created || 0) || a.name.localeCompare(b.name));

function renderProject() {
  if (!store) return;
  const st = store.status();
  if (!S.exists) {
    const waited = Date.now() - openedAt;
    const giveUp = (st.loaded && waited > 4500) || waited > 11500;
    $top.replaceChildren(brand());
    $main.replaceChildren(giveUp
      ? h('div', { class: 'hero stack' },
        h('h2', {}, 'Project not found'),
        h('p', { class: 'muted' }, `No project uses the key ${projectKey}. Check the key with whoever shared it.`,
          st.connected === 0 ? ' You also seem to be offline right now.' : ''),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { onclick: () => openProject(projectKey) }, 'Try again'),
          h('a', { class: 'btn primary', href: '#/' }, 'Back home')))
      : h('div', { class: 'hero' }, h('h2', {}, 'Finding project…'), h('p', { class: 'muted' }, 'Connecting to the sync network.')));
    return;
  }

  remember(projectKey, S.name);
  document.title = `${S.name} · MeetSync`;
  renderTopbar(st);

  const cal = document.querySelector('.cal-scroll');
  if (cal) scrollMemo = { top: cal.scrollTop, left: cal.scrollLeft };

  const my = me();
  const banner = !my
    ? h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', {}, 'Who are you? '), 'Add yourself so the team can see when you\'re free.'),
      h('button', { class: 'primary', onclick: whoAreYou }, 'Add me'))
    : !(my.avail || []).some((d) => d && d.length)
      ? h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', {}, 'Set your hours. '), 'Paint the times you\'re usually available each week.'),
        h('button', { class: 'primary', onclick: () => editPerson(my.id) }, 'Set availability'))
      : null;

  $main.replaceChildren(
    h('div', { class: 'layout' },
      h('div', {}, banner, renderToolbar(), renderCalendar()),
      renderSide()));

  const newCal = document.querySelector('.cal-scroll');
  if (newCal) {
    if (scrollMemo) { newCal.scrollTop = scrollMemo.top; newCal.scrollLeft = scrollMemo.left; }
    else newCal.scrollTop = Math.max(0, (firstFreeSlot < SLOTS ? firstFreeSlot - 2 : 16)) * cellH();
  }

  if (!my && !whoAsked) { whoAsked = true; whoAreYou(); }
}
let whoAsked = false;
let firstFreeSlot = SLOTS; // earliest row anyone is free this week, for the initial scroll position

function cellH() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-h')) || 20;
}

function renderTopbar(st) {
  const my = me();
  const syncOk = st.connected > 0;
  $top.replaceChildren(
    brand(),
    h('span', { class: 'muted sep' }, '/'),
    h('span', { class: 'project-name', title: S.name }, S.name),
    h('span', { class: 'keychip', title: 'Project key. Share it with anyone who should join.' },
      projectKey,
      h('button', { class: 'primary', onclick: () => copy(projectKey, 'Project key copied') }, 'Copy')),
    h('span', { class: 'sync', title: `Connected to ${st.connected} of ${st.total} sync relays` },
      h('span', { class: 'dot ' + (syncOk ? 'ok' : 'warn') }), syncOk ? 'Synced' : 'Offline, saved on this device'),
    h('span', { class: 'grow' }),
    my
      ? h('button', { class: 'ghost', onclick: () => editPerson(my.id), title: 'Edit your details' }, avatar(my, 24), h('span', { class: 'me-name' }, my.name))
      : h('button', { onclick: whoAreYou }, 'Add me'));
}

function weekDays() {
  const tz = viewTz();
  const start = addDays(weekStart(Date.now(), tz), weekOffset * 7);
  return [...Array(7)].map((_, i) => {
    const d = addDays(start, i);
    const t0 = zonedToUtc(d.y, d.m, d.d, 0, tz);
    const next = addDays(d, 1);
    return { ...d, t0, t1: zonedToUtc(next.y, next.m, next.d, 0, tz) };
  });
}

function renderToolbar() {
  const days = weekDays();
  const tz = viewTz();
  const a = fmtDate(days[0].t0 + 12 * 3600e3, tz, { month: 'short', day: 'numeric' });
  const b = fmtDate(days[6].t0 + 12 * 3600e3, tz, { month: 'short', day: 'numeric', year: 'numeric' });
  return h('div', { class: 'toolbar' },
    h('button', { class: 'icon', 'aria-label': 'Previous week', onclick: () => { weekOffset--; renderProject(); } }, '‹'),
    h('button', { onclick: () => { weekOffset = 0; scrollMemo = null; renderProject(); } }, 'Today'),
    h('button', { class: 'icon', 'aria-label': 'Next week', onclick: () => { weekOffset++; renderProject(); } }, '›'),
    h('span', { class: 'week-label' }, `${a} – ${b}`),
    h('span', { class: 'muted small grow tz-note' }, `Shown in your time: ${tzLabel(tz)}`),
    h('button', { class: 'primary', onclick: () => meetingForm() }, '+ New meeting'));
}

// Weekly availability of a member turned into absolute [start, end] ms intervals around a range.
function memberIntervals(m, from, to) {
  const tz = isValidTz(m.tz) ? m.tz : 'UTC';
  const av = m.avail || [];
  const first = addDays(zoned(from, tz), -1);
  const n = Math.ceil((to - from) / DAY) + 3;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(first, i);
    for (const [s, e] of av[d.wd] || []) out.push([zonedToUtc(d.y, d.m, d.d, s, tz), zonedToUtc(d.y, d.m, d.d, e, tz)]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  return merged.filter(([s, e]) => e > from - DAY && s < to + DAY);
}

const isFree = (ivs, t0, t1) => ivs.some(([s, e]) => s <= t0 && e >= t1);

function renderCalendar() {
  const tz = viewTz();
  const days = weekDays();
  const people = members();
  const hid = hidden();
  const shown = people.filter((m) => !hid.has(m.id));
  const ivs = new Map(people.map((m) => [m.id, memberIntervals(m, days[0].t0, days[6].t1)]));
  const now = Date.now();
  const todayKey = ymdKey(zoned(now, tz));
  const ch = cellH();
  firstFreeSlot = SLOTS;

  const grid = h('div', { class: 'cal' });
  grid.append(h('div', { class: 'cal-head corner' }, h('div', { class: 'dname' }, shortTz(tz, days[0].t0))));
  for (const d of days) {
    grid.append(h('div', { class: 'cal-head' + (ymdKey(d) === todayKey ? ' today' : '') },
      h('div', { class: 'dname' }, DAY_SHORT[d.wd]), h('div', { class: 'dnum' }, d.d)));
  }
  const times = h('div', { class: 'times' });
  for (let j = 0; j < SLOTS; j++) times.append(h('div', {}, j % 2 === 0 && j > 0 ? fmtMinutes(j * SLOT).replace(':00', '') : ''));
  grid.append(times);

  const meetings = Object.values(S.meetings);
  for (const d of days) {
    const col = h('div', { class: 'col' });
    for (let j = 0; j < SLOTS; j++) {
      const t0 = zonedToUtc(d.y, d.m, d.d, j * SLOT, tz);
      const t1 = t0 + SLOT * MIN;
      const free = shown.filter((m) => isFree(ivs.get(m.id), t0, t1));
      const all = shown.length >= 2 && free.length === shown.length;
      if (free.length && j < firstFreeSlot) firstFreeSlot = j;
      const busy = shown.filter((m) => !free.includes(m));
      const title = `${fmtDate(t0, tz)} ${fmtTime(t0, tz)}\n` +
        (free.length ? `Free: ${free.map((m) => m.name).join(', ')}` : 'Nobody free') +
        (busy.length && free.length ? `\nNot free: ${busy.map((m) => m.name).join(', ')}` : '') +
        (all ? '\nEveryone is free' : '') + '\nClick to schedule a meeting';
      col.append(h('div', {
        class: `cell ${j % 2 ? 'hour' : 'half'}${all ? ' all' : ''}${t1 <= now ? ' past' : ''}`,
        'data-tip': title,
        onclick: () => meetingForm(null, { start: t0, attendees: free.map((m) => m.id) }),
      }, free.map((m) => h('span', {
        class: 'bar', style: { background: m.color },
        'data-tip': `${m.name}\nFree · ${fmtTime(t0, m.tz)} their time (${shortTz(m.tz, t0)})`,
        'data-color': m.color,
      }))));
    }
    for (const mt of meetings) {
      const s = mt.start;
      const e = mt.start + mt.duration * MIN;
      if (e <= d.t0 || s >= d.t1) continue;
      const top = ((Math.max(s, d.t0) - d.t0) / (SLOT * MIN)) * ch;
      const height = Math.max(((Math.min(e, d.t1) - Math.max(s, d.t0)) / (SLOT * MIN)) * ch - 2, 16);
      col.append(h('div', {
        class: 'mtg', style: { top: top + 'px', height: height + 'px' }, title: mt.title,
        onclick: (ev) => { ev.stopPropagation(); meetingDetails(mt.id); },
      }, h('b', {}, mt.title), height > 30 ? h('span', {}, `${fmtTime(s, tz)} – ${fmtTime(e, tz)}`) : null));
    }
    if (now >= d.t0 && now < d.t1) {
      col.append(h('div', { class: 'now-line', style: { top: ((now - d.t0) / (SLOT * MIN)) * ch + 'px' } }));
    }
    grid.append(col);
  }

  return h('div', { class: 'cal-wrap' },
    h('div', { class: 'cal-scroll' }, grid),
    h('div', { class: 'cal-foot' },
      h('span', {}, 'Each colored bar is a person who\'s free.'),
      h('span', {}, h('span', { class: 'swatch-all' }), ' Everyone checked is free'),
      h('span', {}, 'Click any slot to schedule.')));
}

function renderSide() {
  const people = members();
  const hid = hidden();
  const my = meId();
  const now = Date.now();
  const tz = viewTz();
  const upcoming = Object.values(S.meetings).filter((m) => m.start + m.duration * MIN > now).sort((a, b) => a.start - b.start);
  const past = Object.values(S.meetings).filter((m) => m.start + m.duration * MIN <= now).sort((a, b) => b.start - a.start);

  const toggle = (id, on) => {
    const set = hidden();
    if (on) set.delete(id); else set.add(id);
    local.set(`ms:hidden:${projectKey}`, [...set]);
    renderProject();
  };

  const meetingRow = (m) => h('div', { class: 'meeting-item', onclick: () => meetingDetails(m.id) },
    h('b', {}, m.title),
    h('span', {}, `${fmtDate(m.start, tz)} · ${fmtTime(m.start, tz)} – ${fmtTime(m.start + m.duration * MIN, tz)}`));

  return h('aside', { class: 'side' },
    h('div', { class: 'card' },
      h('h3', {}, `People (${people.length})`, h('button', { class: 'sm', onclick: () => editPerson(null) }, '+ Add')),
      people.length ? null : h('p', { class: 'muted small' }, 'Nobody yet. Add yourself first.'),
      people.map((m) => h('div', { class: 'person' },
        h('input', {
          type: 'checkbox', class: 'toggle', checked: !hid.has(m.id), title: 'Include in the calendar overlap',
          'aria-label': `Show ${m.name} on the calendar`, onchange: (e) => toggle(m.id, e.target.checked),
        }),
        avatar(m),
        h('div', { class: 'who', onclick: () => viewPerson(m.id), title: 'See details and availability' },
          h('b', {}, m.name, m.id === my ? h('span', { class: 'you-tag' }, 'you') : null),
          h('span', {}, `${fmtTime(now, m.tz)} · ${shortTz(m.tz)}`)))),
      people.length ? h('p', { class: 'muted small', style: { margin: '10px 0 0' } }, 'Tap a name for details. Untick to leave someone out of the overlap.') : null),
    h('div', { class: 'card' },
      h('h3', {}, 'Meetings', h('button', { class: 'sm', onclick: () => meetingForm() }, '+ New')),
      upcoming.length ? upcoming.map(meetingRow) : h('p', { class: 'muted small', style: { margin: 0 } }, 'No upcoming meetings.'),
      past.length ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'muted small' }, `Past (${past.length})`),
        h('div', { style: { marginTop: '8px' } }, past.slice(0, 20).map(meetingRow))) : null),
    h('div', { class: 'card' },
      h('h3', {}, 'Project'),
      h('div', { class: 'stack small' },
        h('div', {}, h('div', { class: 'muted' }, 'Key'), h('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 700 } }, projectKey)),
        h('div', { class: 'row' },
          h('button', { class: 'sm', onclick: () => copy(`${siteBase()}#/p/${projectKey}`, 'Join link copied') }, 'Copy join link'),
          h('button', { class: 'sm', onclick: renameProject }, 'Rename')),
        h('button', {
          class: 'sm ghost danger', onclick: () => {
            if (confirm('Remove this project from this device? Everyone else keeps it, and you can rejoin with the key.')) { forget(projectKey); location.hash = '#/'; }
          },
        }, 'Remove from this device'))));
}

function renameProject() {
  const input = h('input', { value: S.name, maxlength: '80' });
  const close = modal(h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      store.put('meta', { name, created: S.created || Date.now() });
      close();
      toast('Project renamed');
    },
  }, modalHead('Rename project', () => close()), h('label', { class: 'field' }, h('span', {}, 'Name'), input),
  h('div', { class: 'modal-foot' }, h('button', { type: 'button', onclick: () => close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
}

// ---- people ------------------------------------------------------------------------------------

function whoAreYou() {
  const people = members();
  const close = modal(h('div', {},
    modalHead(`Welcome to ${S.name}`, () => close(), 'Tell the team who you are. You can change this any time.'),
    people.length ? h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, 'Already on the list? Pick yourself:'),
      h('div', {}, people.map((m) => h('div', { class: 'person' }, avatar(m),
        h('div', { class: 'who' }, h('b', {}, m.name), h('span', {}, tzLabel(m.tz))),
        h('button', { class: 'sm', onclick: () => { setMe(m.id); close(); renderProject(); toast(`Hi ${m.name}!`); } }, 'That\'s me'))))) : null,
    h('div', { class: 'modal-foot' },
      h('button', { class: 'ghost left', onclick: () => close() }, 'Just looking'),
      h('button', { class: 'primary', onclick: () => { close(); editPerson(null, { asMe: true }); } }, people.length ? 'I\'m new, add me' : 'Add me'))));
}

function nextColor() {
  const used = new Set(members().map((m) => m.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[members().length % COLORS.length];
}

function emptyAvail() { return [[], [], [], [], [], [], []]; }

function availToGrid(avail) {
  const g = [...Array(7)].map(() => Array(SLOTS).fill(false));
  (avail || []).forEach((ranges, wd) => (ranges || []).forEach(([s, e]) => {
    for (let j = Math.floor(s / SLOT); j < Math.ceil(e / SLOT) && j < SLOTS; j++) g[wd][j] = true;
  }));
  return g;
}

function gridToAvail(g) {
  return g.map((col) => {
    const out = [];
    let start = -1;
    for (let j = 0; j <= SLOTS; j++) {
      if (j < SLOTS && col[j]) { if (start < 0) start = j; } else if (start >= 0) { out.push([start * SLOT, j * SLOT]); start = -1; }
    }
    return out;
  });
}

function editPerson(id, { asMe = false } = {}) {
  const existing = id ? S.members[id] : null;
  const isNew = !existing;
  const nameIn = h('input', { value: existing ? existing.name : '', maxlength: '60', placeholder: 'Your name' });
  const tzIn = tzSelect(existing ? existing.tz : browserTz());
  let color = existing ? existing.color : nextColor();
  const grid = availToGrid(existing ? existing.avail : emptyAvail());
  const err = h('div', { class: 'error' });

  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => {
    swatches.replaceChildren(...COLORS.map((c) => h('button', {
      type: 'button', class: c === color ? 'sel' : '', style: { background: c }, 'aria-label': `Color ${c}`,
      onclick: () => { color = c; drawSwatches(); editor.style.setProperty('--sel', color); },
    })));
  };
  drawSwatches();

  // Paintable weekly grid (Mon..Sun columns, 30-minute rows) in the person's own time zone.
  const editor = h('div', { class: 'avail' });
  editor.style.setProperty('--sel', color);
  const cells = [...Array(7)].map(() => []);
  editor.append(h('div', { class: 'h' }));
  DISPLAY_DAYS.forEach((wd) => editor.append(h('div', { class: 'h' }, DAY_SHORT[wd])));
  for (let j = 0; j < SLOTS; j++) {
    editor.append(h('div', { class: 't' }, j % 2 === 0 ? fmtMinutes(j * SLOT).replace(':00', '') : ''));
    DISPLAY_DAYS.forEach((wd) => {
      const c = h('div', { class: `c${j % 2 === 0 ? ' hr' : ''}${grid[wd][j] ? ' on' : ''}`, 'data-wd': wd, 'data-j': j });
      cells[wd][j] = c;
      editor.append(c);
    });
  }
  const setCell = (wd, j, on) => { grid[wd][j] = on; cells[wd][j].classList.toggle('on', on); };
  const redraw = () => grid.forEach((col, wd) => col.forEach((on, j) => cells[wd][j].classList.toggle('on', on)));
  let paint = null;
  const cellAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el.classList && el.classList.contains('c') && editor.contains(el) ? el : null;
  };
  // Mouse/pen: press and drag to paint. Touch: tap toggles a cell, a normal swipe scrolls,
  // and press-and-hold then drag paints (like click-and-drag on a computer).
  const touchUI = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  let suppressClickUntil = 0;
  editor.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) return;
    const c = e.target.closest && e.target.closest('.c');
    if (c) setCell(+c.dataset.wd, +c.dataset.j, !grid[+c.dataset.wd][+c.dataset.j]);
  });
  editor.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    const c = cellAt(e);
    if (!c) return;
    suppressClickUntil = Date.now() + 60000;
    e.preventDefault();
    const wd = +c.dataset.wd; const j = +c.dataset.j;
    paint = !grid[wd][j];
    setCell(wd, j, paint);
    editor.setPointerCapture(e.pointerId);
  });
  editor.addEventListener('pointermove', (e) => {
    if (paint == null || e.pointerType === 'touch') return;
    const c = cellAt(e);
    if (c) setCell(+c.dataset.wd, +c.dataset.j, paint);
  });
  const stop = (e) => {
    if (e.pointerType === 'touch') return;
    if (paint != null) suppressClickUntil = Date.now() + 50; // swallow the click that ends a drag
    paint = null;
  };
  editor.addEventListener('pointerup', stop);
  editor.addEventListener('pointercancel', stop);

  const HOLD_MS = 300;
  let hold = null; // { x, y, timer }
  let touchPaint = false;
  let autoScroll = 0;
  let lastTouch = null;
  const touchCell = (t) => {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    return el && el.classList && el.classList.contains('c') && editor.contains(el) ? el : null;
  };
  const endTouch = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
    if (touchPaint) suppressClickUntil = Date.now() + 500;
    touchPaint = false;
    paint = null;
    cancelAnimationFrame(autoScroll);
    autoScroll = 0;
    editor.classList.remove('touch-painting');
  };
  // Keep painting while the finger rests near the top or bottom edge of the scroll area.
  const edgeScroll = () => {
    if (!touchPaint || !lastTouch) { autoScroll = 0; return; }
    const r = scroller.getBoundingClientRect();
    const dy = lastTouch.clientY < r.top + 36 ? -8 : lastTouch.clientY > r.bottom - 36 ? 8 : 0;
    if (dy) {
      scroller.scrollTop += dy;
      const c = touchCell(lastTouch);
      if (c) setCell(+c.dataset.wd, +c.dataset.j, paint);
    }
    autoScroll = requestAnimationFrame(edgeScroll);
  };
  editor.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { endTouch(); return; }
    const t = e.touches[0];
    const c = touchCell(t);
    if (!c) return;
    lastTouch = t;
    hold = {
      x: t.clientX,
      y: t.clientY,
      timer: setTimeout(() => {
        const cell = touchCell(lastTouch) || c;
        touchPaint = true;
        paint = !grid[+cell.dataset.wd][+cell.dataset.j];
        setCell(+cell.dataset.wd, +cell.dataset.j, paint);
        editor.classList.add('touch-painting');
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
        autoScroll = requestAnimationFrame(edgeScroll);
      }, HOLD_MS),
    };
  }, { passive: true });
  editor.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    lastTouch = t;
    if (touchPaint) {
      e.preventDefault(); // stop the page from scrolling while painting
      const c = touchCell(t);
      if (c) setCell(+c.dataset.wd, +c.dataset.j, paint);
      return;
    }
    // Moved before the hold finished: it's a scroll, not a paint.
    if (hold && Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 8) { clearTimeout(hold.timer); hold = null; }
  }, { passive: false });
  editor.addEventListener('touchend', endTouch);
  editor.addEventListener('touchcancel', endTouch);
  editor.addEventListener('contextmenu', (e) => e.preventDefault());

  const preset = (fn) => { fn(); redraw(); };
  const tools = h('div', { class: 'avail-tools' },
    h('button', { type: 'button', class: 'sm', onclick: () => preset(() => [1, 2, 3, 4, 5].forEach((wd) => { for (let j = 0; j < SLOTS; j++) grid[wd][j] = j >= 18 && j < 34; })) }, 'Weekdays 9–5'),
    h('button', { type: 'button', class: 'sm', onclick: () => preset(() => [2, 3, 4, 5].forEach((wd) => { grid[wd] = [...grid[1]]; })) }, 'Copy Monday to Tue–Fri'),
    h('button', { type: 'button', class: 'sm', onclick: () => preset(() => grid.forEach((col) => col.fill(false))) }, 'Clear all'));
  const scroller = h('div', { class: 'avail-scroll' }, editor);
  const tzNote = h('span', {});
  const updateTzNote = () => {
    const how = touchUI
      ? 'Tap to mark the hours you\'re usually free, or press and hold, then drag to paint several at once'
      : 'Click or drag to paint the hours you\'re usually free';
    tzNote.textContent = `${how}. Times are in ${tzIn.value.replace(/_/g, ' ')} time.`;
  };
  tzIn.addEventListener('change', updateTzNote);
  updateTzNote();

  const save = async (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) { err.textContent = 'Please enter a name.'; nameIn.focus(); return; }
    const pid = id || newId();
    const data = { name, tz: tzIn.value, color, avail: gridToAvail(grid), created: existing ? existing.created || Date.now() : Date.now() };
    store.put(`member:${pid}`, data);
    if (isNew && (asMe || !meId())) setMe(pid);
    close();
    toast(isNew ? `Added ${name}` : 'Saved');
  };

  const del = async () => {
    if (!confirm(`Remove ${existing.name} from this project?`)) return;
    store.remove(`member:${id}`);
    if (meId() === id) local.del(`ms:me:${projectKey}`);
    close();
    toast(`Removed ${existing.name}`);
  };

  const title = isNew ? (asMe || !meId() ? 'Add yourself' : 'Add a person') : (id === meId() ? 'Your details' : `Edit ${existing.name}`);
  const close = modal(h('form', { onsubmit: save },
    modalHead(title, () => close()),
    h('div', { class: 'stack' },
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
        h('label', { class: 'field' }, h('span', {}, 'Time zone'), tzIn)),
      h('div', { class: 'field' }, h('span', { class: 'muted small', style: { fontWeight: 600 } }, 'Color'), swatches),
      h('div', {},
        h('div', { class: 'row' }, h('b', {}, 'Weekly availability')),
        h('div', { class: 'muted small' }, tzNote),
        tools, scroller),
      err),
    h('div', { class: 'modal-foot' },
      !isNew ? h('button', { type: 'button', class: 'danger left', onclick: del }, 'Remove') : null,
      !isNew && id !== meId() ? h('button', { type: 'button', class: 'left', onclick: () => { setMe(id); close(); renderProject(); toast(`You are now ${existing.name}`); } }, 'This is me') : null,
      h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, isNew ? 'Add' : 'Save'))), { wide: true });
  setTimeout(() => {
    // Start around 7 AM, or at the person's earliest saved hour if that's earlier.
    const first = Math.min(14, ...grid.map((col) => col.indexOf(true)).filter((j) => j >= 0));
    scroller.scrollTop = cells[1][first].getBoundingClientRect().top - editor.getBoundingClientRect().top - 30;
  }, 0);
}

// Availability of a person for each of their weekdays, in their time and converted to the viewer's.
function viewPerson(id) {
  const m = S.members[id];
  if (!m) return;
  const vtz = viewTz();
  const same = offsetMin(Date.now(), vtz) === offsetMin(Date.now(), m.tz);
  const days = weekDays();
  const ivs = memberIntervals(m, days[0].t0, days[6].t1);
  const rows = [];
  // Walk the displayed week in the person's own calendar days.
  const firstOwn = zoned(days[0].t0 + 12 * 3600e3, m.tz);
  for (let i = 0; i < 7; i++) {
    const d = addDays(firstOwn, i);
    const ranges = (m.avail || [])[d.wd] || [];
    const theirs = ranges.map(([s, e]) => `${fmtMinutes(s)} – ${fmtMinutes(e)}`);
    const yours = ranges.map(([s, e]) => {
      const a = zonedToUtc(d.y, d.m, d.d, s, m.tz);
      const b = zonedToUtc(d.y, d.m, d.d, e, m.tz);
      const da = fmtDate(a, vtz, { weekday: 'short' });
      const db = fmtDate(b - 1, vtz, { weekday: 'short' });
      return `${da} ${fmtTime(a, vtz)} – ${db !== da ? db + ' ' : ''}${fmtTime(b, vtz)}`;
    });
    rows.push(h('tr', {},
      h('td', {}, h('b', {}, DAY_NAMES[d.wd])),
      h('td', {}, theirs.length ? theirs.map((t) => h('div', {}, t)) : h('span', { class: 'muted' }, 'Not available')),
      same ? null : h('td', {}, yours.length ? yours.map((t) => h('div', {}, t)) : h('span', { class: 'muted' }, '·'))));
  }
  const totalH = (m.avail || []).flat().reduce((sum, [s, e]) => sum + (e - s), 0) / 60;
  const freeNow = isFree(ivs, Date.now(), Date.now() + 1);

  const close = modal(h('div', {},
    h('div', { class: 'modal-head' }, avatar(m, 44),
      h('div', { class: 'grow' }, h('h2', {}, m.name, m.id === meId() ? h('span', { class: 'you-tag' }, 'you') : null),
        h('div', { class: 'muted small', style: { marginTop: '4px' } }, freeNow ? 'Available right now' : 'Not available right now')),
      h('button', { class: 'ghost icon', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    h('div', { class: 'facts' },
      h('div', {}, h('span', {}, 'Their time zone'), h('b', {}, tzLabel(m.tz))),
      h('div', {}, h('span', {}, 'Their time now'), h('b', {}, fmtTime(Date.now(), m.tz))),
      h('div', {}, h('span', {}, 'Difference from you'), h('b', {}, diffLabel(m.tz, vtz))),
      h('div', {}, h('span', {}, 'Hours per week'), h('b', {}, `${+totalH.toFixed(1)} h`))),
    h('table', { class: 'avail-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, `Their time (${shortTz(m.tz)})`), same ? null : h('th', {}, `Your time (${shortTz(vtz)})`))),
      h('tbody', {}, rows)),
    same ? h('p', { class: 'muted small' }, 'Same time zone as you.') : null,
    h('div', { class: 'modal-foot' },
      h('button', { onclick: () => { close(); meetingForm(null, { attendees: [id, meId()].filter(Boolean) }); } }, 'Schedule with them'),
      h('button', { class: 'primary', onclick: () => { close(); editPerson(id); } }, 'Edit'))), { wide: true });
}

function diffLabel(tz, vtz) {
  const d = offsetMin(Date.now(), tz) - offsetMin(Date.now(), vtz);
  if (!d) return 'Same as you';
  const a = Math.abs(d);
  const txt = `${Math.floor(a / 60)}${a % 60 ? `h ${a % 60}m` : 'h'}`;
  return d > 0 ? `${txt} ahead` : `${txt} behind`;
}

// ---- meetings ----------------------------------------------------------------------------------

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

function meetingForm(id, preset = {}) {
  const existing = id ? S.meetings[id] : null;
  const tz = viewTz();
  let start = existing ? existing.start : preset.start;
  if (!start) {
    const n = Date.now() + 60 * MIN;
    start = Math.ceil(n / (30 * MIN)) * 30 * MIN;
  }
  const z = zoned(start, tz);
  const titleIn = h('input', { value: existing ? existing.title : '', maxlength: '120', placeholder: 'e.g. Sprint planning' });
  const dateIn = h('input', { type: 'date', value: ymdKey(z) });
  const timeIn = h('input', { type: 'time', step: '300', value: `${String(z.h).padStart(2, '0')}:${String(z.mi).padStart(2, '0')}` });
  const dur = existing ? existing.duration : 60;
  const durIn = h('select', {}, [...new Set([...DURATIONS, dur])].sort((a, b) => a - b).map((d) => h('option', { value: d }, d < 60 ? `${d} min` : `${d / 60} hour${d > 60 ? 's' : ''}`)));
  durIn.value = String(dur);
  const locIn = h('input', { value: existing ? existing.location || '' : '', placeholder: 'Video link, room or address (optional)' });
  const notesIn = h('textarea', { placeholder: 'Agenda or notes (optional)' });
  notesIn.value = existing ? existing.notes || '' : '';
  const err = h('div', { class: 'error' });

  const people = members();
  const chosen = new Set(existing ? existing.attendees : (preset.attendees || [meId()]).filter(Boolean));
  if (!existing && meId()) chosen.add(meId());
  const attBox = h('div', { class: 'attendees' });
  const suggestBox = h('div', {});

  const currentStart = () => {
    if (!dateIn.value || !timeIn.value) return null;
    const d = parseYmd(dateIn.value);
    const [hh, mm] = timeIn.value.split(':').map(Number);
    return zonedToUtc(d.y, d.m, d.d, hh * 60 + mm, tz);
  };

  const attSearch = h('input', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people', class: 'att-search' });
  const attCount = h('span', { class: 'muted small' });
  const freeNow = new Map();
  const visible = () => {
    const q = attSearch.value.trim().toLowerCase();
    return people.filter((m) => !q || m.name.toLowerCase().includes(q));
  };
  const updateCount = () => {
    const n = people.filter((m) => chosen.has(m.id)).length;
    attCount.textContent = `${n} of ${people.length} invited`;
  };

  const drawAttendees = () => {
    const s = currentStart();
    const e = s == null ? null : s + Number(durIn.value) * MIN;
    const rows = visible();
    attBox.replaceChildren(...(!people.length ? [h('div', { class: 'att muted small' }, 'No people in this project yet.')]
      : !rows.length ? [h('div', { class: 'att muted small' }, `Nobody matches "${attSearch.value.trim()}".`)]
        : rows.map((m) => {
          const cb = h('input', { type: 'checkbox', class: 'toggle', checked: chosen.has(m.id), onchange: (ev) => { if (ev.target.checked) chosen.add(m.id); else chosen.delete(m.id); updateCount(); } });
          let status = null;
          if (s != null) {
            const free = isFree(memberIntervals(m, s - DAY, e + DAY), s, e);
            freeNow.set(m.id, free);
            status = h('span', { class: 'pill ' + (free ? 'free' : 'busy') }, free ? 'Free' : 'Outside hours');
          }
          return h('label', { class: 'att' }, cb, avatar(m, 26),
            h('div', { class: 'grow' }, h('b', {}, m.name),
              s != null ? h('div', { class: 'muted small' }, `${fmtDate(s, m.tz, { weekday: 'short' })} ${fmtTime(s, m.tz)} their time`) : null),
            status);
        })));
    updateCount();
  };
  attSearch.addEventListener('input', drawAttendees);
  attSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  const bulk = (fn) => { visible().forEach(fn); drawAttendees(); };
  const attTools = people.length > 1 ? h('div', { class: 'att-tools' },
    attSearch,
    h('button', { type: 'button', class: 'sm', onclick: () => bulk((m) => chosen.add(m.id)) }, 'Select all'),
    h('button', { type: 'button', class: 'sm', onclick: () => bulk((m) => (freeNow.get(m.id) ? chosen.add(m.id) : chosen.delete(m.id))) }, 'Only free'),
    h('button', { type: 'button', class: 'sm', onclick: () => bulk((m) => chosen.delete(m.id)) }, 'Clear'),
    h('span', { class: 'grow' }),
    attCount) : null;
  [dateIn, timeIn, durIn].forEach((el) => el.addEventListener('change', () => { drawAttendees(); suggestBox.replaceChildren(); }));
  drawAttendees();

  const findTimes = () => {
    const ids = [...chosen].filter((x) => S.members[x]);
    if (!ids.length) { suggestBox.replaceChildren(h('div', { class: 'muted small' }, 'Tick at least one person first.')); return; }
    const len = Number(durIn.value) * MIN;
    const from = Math.ceil(Date.now() / (30 * MIN)) * 30 * MIN;
    const to = from + 21 * DAY;
    const lists = ids.map((x) => memberIntervals(S.members[x], from, to));
    const found = [];
    for (let t = from; t < to && found.length < 6; t += 30 * MIN) {
      if (lists.every((l) => isFree(l, t, t + len))) {
        found.push(t);
        // skip ahead so suggestions spread out instead of listing every half hour of one block
        while (t + 30 * MIN < to && lists.every((l) => isFree(l, t + 30 * MIN, t + 30 * MIN + len)) && zoned(t + 30 * MIN, tz).d === zoned(found[found.length - 1], tz).d) t += 30 * MIN;
      }
    }
    suggestBox.replaceChildren(found.length
      ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'muted small' }, 'Everyone is free:'),
        found.map((t) => h('button', {
          type: 'button', class: 'sm', onclick: () => {
            const zz = zoned(t, tz);
            dateIn.value = ymdKey(zz);
            timeIn.value = `${String(zz.h).padStart(2, '0')}:${String(zz.mi).padStart(2, '0')}`;
            drawAttendees();
          },
        }, `${fmtDate(t, tz)} ${fmtTime(t, tz)}`)))
      : h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'No time in the next 3 weeks where everyone ticked is free for that long.'));
  };

  const save = (e) => {
    e.preventDefault();
    const title = titleIn.value.trim();
    const s = currentStart();
    if (!title) { err.textContent = 'Give the meeting a title.'; titleIn.focus(); return; }
    if (s == null) { err.textContent = 'Pick a date and time.'; return; }
    const mid = id || newId();
    store.put(`meeting:${mid}`, {
      title, start: s, duration: Number(durIn.value), attendees: [...chosen].filter((x) => S.members[x]),
      location: locIn.value.trim(), notes: notesIn.value.trim(), tz,
      created: existing ? existing.created : Date.now(), createdBy: existing ? existing.createdBy : meId(),
    });
    close();
    setTimeout(() => meetingDetails(mid, !existing), 60);
  };

  const close = modal(h('form', { onsubmit: save },
    modalHead(existing ? 'Edit meeting' : 'New meeting', () => close(), `Times in your time zone: ${tzLabel(tz)}`),
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', {}, 'Title'), titleIn),
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, h('span', {}, 'Date'), dateIn),
        h('label', { class: 'field' }, h('span', {}, 'Start'), timeIn),
        h('label', { class: 'field' }, h('span', {}, 'Length'), durIn)),
      h('div', {},
        h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('b', { class: 'grow' }, 'Who\'s invited'),
          h('button', { type: 'button', class: 'sm', onclick: findTimes }, 'Find a time everyone is free')),
        attTools, attBox, suggestBox),
      h('label', { class: 'field' }, h('span', {}, 'Where'), locIn),
      h('label', { class: 'field' }, h('span', {}, 'Notes'), notesIn),
      err),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, existing ? 'Save changes' : 'Create meeting'))), { wide: true });
}

function inviteFor(mt) {
  return {
    id: mt.id, title: mt.title, start: mt.start, duration: mt.duration, location: mt.location, notes: mt.notes, tz: mt.tz,
    attendees: (mt.attendees || []).map((x) => S.members[x] && S.members[x].name).filter(Boolean),
  };
}

function meetingDetails(id, justCreated = false) {
  const mt = S && S.meetings[id];
  if (!mt) return;
  const tz = viewTz();
  const end = mt.start + mt.duration * MIN;
  const inv = inviteFor(mt);
  const url = inviteUrl(inv);
  const message = [
    `You're invited: ${mt.title}`,
    `When: ${fmtDateTime(mt.start, tz)} (${shortTz(tz, mt.start)}), ${mt.duration} min`,
    inv.attendees.length ? `With: ${inv.attendees.join(', ')}` : null,
    mt.location ? `Where: ${mt.location}` : null,
    '',
    `See it in your time zone and add it to your calendar: ${url}`,
  ].filter((x) => x != null).join('\n');

  const attendees = (mt.attendees || []).map((x) => S.members[x]).filter(Boolean);
  const urlIn = h('input', { value: url, readonly: true, onfocus: (e) => e.target.select() });

  const close = modal(h('div', {},
    modalHead(mt.title, () => close(), justCreated ? 'Meeting created. Share the invite link below.' : null),
    h('div', { class: 'facts' },
      h('div', {}, h('span', {}, 'When (your time)'), h('b', {}, `${fmtDate(mt.start, tz)}, ${fmtTime(mt.start, tz)} – ${fmtTime(end, tz)}`)),
      h('div', {}, h('span', {}, 'Length'), h('b', {}, `${mt.duration} min`)),
      mt.location ? h('div', {}, h('span', {}, 'Where'), h('b', { style: { wordBreak: 'break-word' } }, mt.location)) : null),
    attendees.length ? h('table', { class: 'avail-table', style: { marginBottom: '14px' } },
      h('thead', {}, h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'Their local time'))),
      h('tbody', {}, attendees.map((m) => h('tr', {},
        h('td', {}, h('span', { class: 'row', style: { gap: '8px' } }, avatar(m, 22), m.name)),
        h('td', {}, `${fmtDate(mt.start, m.tz, { weekday: 'short' })} ${fmtTime(mt.start, m.tz)} – ${fmtTime(end, m.tz)} ${shortTz(m.tz, mt.start)}`))))) : null,
    mt.notes ? h('p', { class: 'notes' }, mt.notes) : null,
    h('div', { class: 'stack' },
      h('b', {}, 'Invite link'),
      h('div', { class: 'muted small' }, 'Anyone who opens it sees the time in their own time zone and can add it to Google, Apple, Outlook, Yahoo and more.'),
      h('div', { class: 'linkbox' }, urlIn, h('button', { class: 'primary', onclick: () => copy(url, 'Invite link copied') }, 'Copy link')),
      h('div', { class: 'row' },
        h('button', { class: 'sm', onclick: () => copy(message, 'Invite message copied') }, 'Copy full invite message'),
        h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open invite page'))),
    h('div', { class: 'modal-foot' },
      h('button', {
        class: 'danger left', onclick: () => {
          if (!confirm(`Delete "${mt.title}"? Calendars people already added it to won't change.`)) return;
          store.remove(`meeting:${id}`);
          close();
          toast('Meeting deleted');
        },
      }, 'Delete'),
      h('button', { onclick: () => { close(); meetingForm(id); } }, 'Edit'),
      h('button', { class: 'primary', onclick: () => close() }, 'Done'))), { wide: true });
}

// Instant hover tooltips for calendar cells and people's availability bars.
const tip = h('div', { class: 'tip', role: 'tooltip' });
document.body.append(tip);
let tipEl = null;
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el === tipEl) return;
  tipEl = el;
  if (!el) { tip.classList.remove('show'); return; }
  const [head, ...rest] = el.dataset.tip.split('\n');
  tip.replaceChildren(
    h('div', { class: 'tip-head' }, el.dataset.color ? h('span', { class: 'tip-dot', style: { background: el.dataset.color } }) : null, head),
    rest.length ? h('div', { class: 'tip-body' }, rest.join('\n')) : null);
  tip.classList.add('show');
});
document.addEventListener('mousemove', (e) => {
  if (!tipEl) return;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
});
document.addEventListener('mouseleave', () => { tipEl = null; tip.classList.remove('show'); });
document.addEventListener('pointerdown', () => { tipEl = null; tip.classList.remove('show'); });

route();
