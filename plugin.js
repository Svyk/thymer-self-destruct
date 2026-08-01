'use strict';

const SD_VERSION = '0.3.1';
const SD_WORKSPACE_GUID = 'WEJ9EZW6ADT58SJC3EQMNETSW6';
const SD_TEMPLATES_COLLECTION_GUID = '1DEGAQTQARK8MKNAFZ9D1MY16W';
const SD_SCRATCHPAD_COLLECTION_GUID = '1G8F9FFY4XFXKA2MBGE2FN39B3';
const SD_LOG_NAME = 'Self-Destruct Log';
const SD_SEARCH_LIMIT = 4000;
const SD_HOURLY_MS = 3600000;
const SD_FIRST_PASS_MS = 8000;
const SD_MULTI_CLIENT_MS = 15 * 60 * 1000;
const SD_EDITOR_QUIET_MS = 2000;
const SD_EDITOR_POLL_MS = 250;
const SD_BATCH_SIZE = 10;
const SD_HARD_WRITE_CAP = 300;
const SD_FAILURE_CAP = 10;
const SD_STATS_LIMIT = 20;
const SD_LOG_SWEEP_LIMIT = 50;
const SD_LOG_CONTENT_LIMIT = 50;
const SD_LOG_TEXT_LIMIT = 120;
const SD_SETTINGS_KEY = 'self-destruct-settings-v1';
const SD_LOG_GUID_KEY = 'self-destruct-log-guid-v1';
const SD_RESURRECTED_KEY = 'self-destruct-resurrected-v1';
const SD_RESURRECTED_MAX_AGE_MS = 30 * 86400000;
const SD_RESURRECTED_LIMIT = 500;
const SD_STYLE_ID = 'self-destruct-managed-style';
const SD_CARET_POLL_MS = 400;
const SD_CARET_STASH_MAX_AGE_MS = 3 * 60 * 1000;
const SD_TAG_RE = /^#sd(?:\/|$)/i;
const SD_KEEP_RE = /^#keep(?:\/|$)/i;
const SD_DC_MARKER_RE = /^\s*dc(?:\.js)?\s*[:(]/i;
const SD_SUMMARY_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — /;
const SD_DEFAULTS = Object.freeze({
  defaultDelay: '3d',
  lineWriteBudget: 100,
  dryRun: true,
  logEnabled: true,
  contentLog: true,
  hideTags: true,
  logCollection: SD_SCRATCHPAD_COLLECTION_GUID,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function matchesSdTagText(value) {
  return SD_TAG_RE.test(String(value == null ? '' : value).trim());
}

function parseDuration(value) {
  const match = String(value == null ? '' : value).trim().match(/^(\d+)(m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const unit = match[2].toLowerCase();
  const factor = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms)) return null;
  return ms;
}

function parseSdTag(rawTag) {
  const raw = String(rawTag == null ? '' : rawTag);
  if (!SD_TAG_RE.test(raw)) return null;
  const parts = raw.split('/');
  if (!/^#sd$/i.test(parts[0])) return null;
  const tokens = parts.slice(1).map(token => token.toLowerCase());
  let empty = false;
  let delayMs = null;
  let now = false;
  let malformedToken = null;
  for (const token of tokens) {
    if (!token) { malformedToken = token; break; }
    if (token === 'empty') { empty = true; continue; }
    if (token === 'now') {
      if (delayMs !== null) { malformedToken = token; break; }
      delayMs = 0;
      now = true;
      continue;
    }
    const parsed = parseDuration(token);
    if (parsed === null || delayMs !== null) { malformedToken = token; break; }
    delayMs = parsed;
  }
  const valid = malformedToken === null;
  return Object.freeze({
    raw,
    valid,
    inert: !valid,
    malformedToken,
    tokens: Object.freeze(tokens.slice()),
    empty,
    now,
    explicitDelay: delayMs !== null,
    delayMs,
  });
}

function mergeSdTags(tags, defaultDelayMs) {
  const parsed = (tags || []).map(tag => typeof tag === 'string' ? parseSdTag(tag) : tag).filter(Boolean);
  const active = parsed.filter(tag => tag.valid);
  const malformed = parsed.filter(tag => !tag.valid);
  if (malformed.length || !active.length) {
    return Object.freeze({
      valid: false,
      inert: malformed.length > 0,
      empty: false,
      delayMs: null,
      tags: Object.freeze(parsed.slice()),
      activeTags: Object.freeze([]),
      malformedTags: Object.freeze(malformed.slice()),
    });
  }
  let delayMs = null;
  let empty = false;
  for (const tag of active) {
    empty = empty || tag.empty;
    const candidateDelay = tag.explicitDelay ? tag.delayMs : defaultDelayMs;
    if (Number.isFinite(candidateDelay)) delayMs = delayMs === null ? candidateDelay : Math.max(delayMs, candidateDelay);
  }
  return Object.freeze({
    valid: Number.isFinite(delayMs),
    inert: false,
    empty,
    delayMs,
    tags: Object.freeze(parsed.slice()),
    activeTags: Object.freeze(active.slice()),
    malformedTags: Object.freeze(malformed.slice()),
  });
}

function computeDeadline(basis, delayMs) {
  if (basis == null || delayMs == null) return null;
  const basisMs = basis instanceof Date ? basis.getTime() : Number(basis);
  const delay = Number(delayMs);
  if (!Number.isFinite(basisMs) || !Number.isFinite(delay) || delay < 0) return null;
  const deadline = basisMs + delay;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

// Copied verbatim from thymer-attributes/plugin.js (same author).
const ATTR_RE = /^\s*([\p{L}][\p{L}\p{N} _/&,’’().+\-–—]{0,48}?)\s*::(?:(?![ \t]+[\p{L}_][\p{L}\p{N}_]*\()[ \t]+(.*\S))?\s*$/u;
const ATTR_NOSPACE_RE = /^\s*([\p{L}][\p{L}\p{N} _/&,'’().+\-–—]{0,48}?)\s*::([^\s:].*\S|[^\s:])\s*$/u;
const attrIsCodeNoise = (key, value) =>
  /^[a-z_$][\w$]*$/.test(key) && /^[\w$]+(::[\w$]+)*(\(.*)?$/.test(value);
const parseAttrLine = (text) => {
  let m = text.match(ATTR_RE);
  if (m) return m;
  m = text.match(ATTR_NOSPACE_RE);
  if (!m) return null;
  const key = (m[1] || '').trim(), value = (m[2] || '').trim();
  if (attrIsCodeNoise(key, value)) return null;
  return m;
};

// Copied verbatim from thymer-attributes/plugin.js (same author).
const lineText = line => (line && line.segments || []).map(segment => typeof segment.text === 'string' ? segment.text : segment.text && segment.text.title || '').join('').trim();

function classifyLine(line) {
  if (!line) return Object.freeze({ empty: true, reason: 'blank' });
  const type = String(line.type || '').toLowerCase();
  if (type === 'task' || (typeof line.getTaskStatus === 'function' && line.getTaskStatus() != null)) {
    return Object.freeze({ empty: false, reason: 'task' });
  }
  const emptyEligibleTypes = new Set(['', 'text', 'ulist', 'olist', 'empty', 'br', 'heading', 'quote']);
  if (!emptyEligibleTypes.has(type)) return Object.freeze({ empty: false, reason: 'type:' + type });
  const segments = line.segments || [];
  const text = segments
    .filter(segment => segment && segment.type !== 'hashtag')
    .map(segment => typeof segment.text === 'string' ? segment.text : segment.text && segment.text.title || '')
    .join('')
    .trim();
  if (SD_DC_MARKER_RE.test(text)) return Object.freeze({ empty: true, reason: 'dc-marker' });
  const semantic = new Set(['ref', 'datetime', 'linkobj', 'mention', 'image', 'file', 'transclusion']);
  for (const segment of segments) {
    if (semantic.has(String(segment && segment.type || '').toLowerCase())) {
      return Object.freeze({ empty: false, reason: 'segment:' + segment.type });
    }
  }
  if (!text) return Object.freeze({ empty: true, reason: 'blank-or-hashtag' });
  const attr = parseAttrLine(text);
  if (attr && !(attr[2] || '').trim()) return Object.freeze({ empty: true, reason: 'bare-attribute' });
  return Object.freeze({ empty: false, reason: attr ? 'filled-attribute' : 'text' });
}

function isSubtreeEmpty(descendants) {
  return (descendants || []).every(line => classifyLine(line).empty);
}

function hasKeepTag(segments) {
  return (segments || []).some(segment => segment && segment.type === 'hashtag' && typeof segment.text === 'string' && SD_KEEP_RE.test(segment.text));
}

function isEmptyDestructTarget(line, descendants) {
  if ((descendants || []).length) return isSubtreeEmpty(descendants);
  const segments = (line && line.segments || []).filter(segment => !(
    segment && segment.type === 'hashtag' && typeof segment.text === 'string' &&
    (SD_TAG_RE.test(segment.text) || SD_KEEP_RE.test(segment.text))
  ));
  const synthetic = {
    type: line && line.type,
    segments,
    getTaskStatus: line && typeof line.getTaskStatus === 'function' ? () => line.getTaskStatus() : undefined,
  };
  return classifyLine(synthetic).empty;
}

function defusedSegments(segments) {
  const output = [];
  let removed = false;
  for (const source of segments || []) {
    if (source && source.type === 'hashtag' && typeof source.text === 'string' && SD_TAG_RE.test(source.text)) {
      removed = true;
      continue;
    }
    const segment = (source && source.type === 'text') ? Object.assign({}, source) : source;
    if (!segment) continue;
    if (removed && output.length === 0 && segment.type === 'text' && typeof segment.text === 'string') {
      segment.text = segment.text.replace(/^\s+/, '');
    }
    if (segment.type === 'text' && typeof segment.text === 'string' && output.length && output[output.length - 1].type === 'text') {
      const previous = output[output.length - 1];
      const leftSpace = /\s$/.test(previous.text);
      const rightSpace = /^\s/.test(segment.text);
      const seam = removed && (leftSpace || rightSpace) ? ' ' : '';
      previous.text = previous.text.replace(/\s+$/, '') + seam + segment.text.replace(/^\s+/, '');
    } else {
      output.push(segment);
    }
    removed = false;
  }
  while (output.length && output[output.length - 1].type === 'text' && typeof output[output.length - 1].text === 'string') {
    output[output.length - 1].text = output[output.length - 1].text.replace(/\s+$/, '');
    if (output[output.length - 1].text || output.length === 1) break;
    output.pop();
  }
  while (output.length > 1 && output[0].type === 'text' && output[0].text === '') output.shift();
  return output.length ? output : [{ type: 'text', text: '' }];
}

function formatCountdown(milliseconds) {
  const ms = Number(milliseconds);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return 'due';
  const units = [
    ['w', 604800000],
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
  ];
  if (ms < 60000) return '<1m';
  let remaining = ms;
  const parts = [];
  for (const [label, size] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(value + label);
      remaining -= value * size;
      if (parts.length === 2) break;
    }
  }
  return parts.join(' ') || '<1m';
}

/*
 * GOAL-2 DATA CONTRACT — FROZEN AT schemaVersion 1
 *
 * VerdictShape = {
 *   schemaVersion: 1,
 *   lineGuid: string, recordGuid: string|null, recordName: string,
 *   collectionGuid: string|null, text: string,
 *   status: 'malformed'|'no-ts'|'wait'|'keep'|'delete'|'defuse'|'skip',
 *   reason: string, basis: 'line-created'|'line-updated'|'journal-date'|'record-created'|null,
 *   basisAt: number|null, deadline: number|null, remainingMs: number|null,
 *   subtreeSize: number, depth: number, empty: boolean|null,
 *   tags: string[], malformedTags: string[], descendants: string[],
 *   deferred: boolean, action: null|{kind:string, ok:boolean, writes:number, partial?:boolean, deletedLines?:number, content?:string[]}
 * }
 *
 * SweepReportShape = {
 *   schemaVersion: 1, sweepId: string, source: 'scheduled'|'manual'|'dry-run',
 *   dryRun: boolean, startedAt: number, finishedAt: number|null, durationMs: number|null,
 *   skipped: boolean, skipReason: string|null, searchCapped: boolean, capped: boolean, truncated: boolean,
 *   circuitBroken: boolean, circuitReason: string|null, candidates: number,
 *   writes: number, writeAttempts: number, failures: number, consecutiveDeleteFailures: number,
 *   deletedLines: number,
 *   counts: {malformed:number,noTs:number,wait:number,keep:number,delete:number,defuse:number,skip:number,wouldDelete:number,wouldDefuse:number,error:number},
 *   verdicts: VerdictShape[], errors: {ts:number,phase:string,lineGuid:string|null,recordGuid:string|null,message:string,stack:string}[]
 * }
 *
 * These keys and meanings are append-only for GOAL-2. New fields may be added, but existing
 * fields must not be renamed, removed, or repurposed without increasing schemaVersion.
 */

function frozenVerdict(fields) {
  return Object.freeze(Object.assign({
    schemaVersion: 1,
    lineGuid: '',
    recordGuid: null,
    recordName: '',
    collectionGuid: null,
    text: '',
    status: 'skip',
    reason: '',
    basis: null,
    basisAt: null,
    deadline: null,
    remainingMs: null,
    subtreeSize: 1,
    depth: 0,
    empty: null,
    tags: Object.freeze([]),
    malformedTags: Object.freeze([]),
    descendants: Object.freeze([]),
    deferred: false,
    action: null,
  }, fields || {}));
}

function newReport(options) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    sweepId: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    source: options.source,
    dryRun: !!options.dryRun,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    skipped: false,
    skipReason: null,
    searchCapped: false,
    capped: false,
    truncated: false,
    circuitBroken: false,
    circuitReason: null,
    candidates: 0,
    writes: 0,
    writeAttempts: 0,
    failures: 0,
    consecutiveDeleteFailures: 0,
    deletedLines: 0,
    counts: { malformed: 0, noTs: 0, wait: 0, keep: 0, delete: 0, defuse: 0, skip: 0, wouldDelete: 0, wouldDefuse: 0, error: 0 },
    verdicts: [],
    errors: [],
  };
}

class Plugin extends AppPlugin {
  onLoad() {
    try { if (window.__sdHideObs) window.__sdHideObs.disconnect(); } catch (_) {}
    try { if (window.__sdHideNavId) this.events.off(window.__sdHideNavId); } catch (_) {}
    try { for (const node of document.querySelectorAll('.sd-tag-caret-line')) node.classList.remove('sd-tag-caret-line'); } catch (_) {}
    window.__SD_VERSION = SD_VERSION;
    let previousDashboardReport = null;
    try { previousDashboardReport = window.__sdInstance && window.__sdInstance._dashboardReport || null; } catch (_) {}
    try { if (typeof window.__sdDispose === 'function') window.__sdDispose(); } catch (_) {}
    try { if (window.__sdInterval) clearInterval(window.__sdInterval); } catch (_) {}
    try { if (window.__sdFirstPass) clearTimeout(window.__sdFirstPass); } catch (_) {}
    try { if (window.__sdActivityHandler) ['keydown','beforeinput','input','pointerdown','compositionstart','wheel','touchstart','visibilitychange'].forEach(name => document.removeEventListener(name, window.__sdActivityHandler, true)); } catch (_) {}
    try { (window.__sdEventIds || []).forEach(id => this.events.off(id)); } catch (_) {}
    try { (window.__sdCommands || []).forEach(command => command && command.remove && command.remove()); } catch (_) {}
    try { if (window.__sdCaretHandler) { document.removeEventListener('mouseup', window.__sdCaretHandler); document.removeEventListener('keyup', window.__sdCaretHandler); } } catch (_) {}
    try { if (window.__sdCaretPoll) clearInterval(window.__sdCaretPoll); } catch (_) {}
    try { if (window.__sdStatusItem && window.__sdStatusItem.remove) window.__sdStatusItem.remove(); } catch (_) {}
    try { if (typeof window.__sdModalCancel === 'function') window.__sdModalCancel(); } catch (_) {}
    for (const key of ['__sdDispose','__sdInterval','__sdFirstPass','__sdActivityHandler','__sdEventIds','__sdCommands','__sdCaretHandler','__sdCaretPoll','__sdStatusItem','__sdModalCancel','__sdPanelMount','__sdInstance','__sdHideObs','__sdHideNavId']) { try { delete window[key]; } catch (_) {} }

    console.log('%c[Self Destruct] v' + SD_VERSION + ' loaded — dry-run first, subtree-safe.', 'color:#ef4444;font-weight:700;font-size:12px');
    this.VERSION = SD_VERSION;
    this._disposed = false;
    this._running = false;
    this._pendingRerun = null;
    this._sweepPromise = null;
    this._eventIds = [];
    this._commands = [];
    this._statusItem = null;
    this._dashboardHosts = new Set();
    this._dashboardReport = previousDashboardReport && previousDashboardReport.schemaVersion === 1 ? previousDashboardReport : null;
    this._dashboardRefreshPromise = null;
    this._caretStash = null;
    this._templateGuids = new Set();
    this._templateGuidsReady = false;
    this._hideObserver = null;
    this._hideNavId = null;
    this._tagCaretLineEl = null;
    this._tagCaretLineGuid = null;
    this._quietWaiters = new Set();
    this._resurrected = this._loadResurrected();
    this._settings = this._loadSettings();
    this._lastActivityAt = Date.now();
    this._activityHandler = () => { if (!this._disposed) this._lastActivityAt = Date.now(); };
    this._activityEvents = ['keydown','beforeinput','input','pointerdown','compositionstart','wheel','touchstart','visibilitychange'];
    try {
      for (const name of this._activityEvents) document.addEventListener(name, this._activityHandler, true);
      window.__sdActivityHandler = this._activityHandler;
    } catch (_) {}

    this._initForensics();
    window.__sdInstance = this;
    this._subscribeUndeletes();
    this._installManagedStyle();
    this._installTagHiding();
    this._registerDashboard();
    this._installCaretStash();
    this._registerCommands();

    this._sweepGlobal = () => this._requestSweep({ manual: true, dryRun: !!this._settings.dryRun, source: 'manual' });
    this._dryGlobal = () => this._requestSweep({ manual: true, dryRun: true, source: 'dry-run' });
    window.__SD_SWEEP = this._sweepGlobal;
    window.__SD_DRY = this._dryGlobal;
    window.__sdInterval = setInterval(() => { this._requestSweep({ manual: false, dryRun: !!this._settings.dryRun, source: 'scheduled' }).catch(() => {}); }, SD_HOURLY_MS);
    window.__sdFirstPass = setTimeout(() => {
      window.__sdFirstPass = null;
      this._requestSweep({ manual: false, dryRun: !!this._settings.dryRun, source: 'scheduled' }).catch(() => {});
    }, SD_FIRST_PASS_MS);
    window.__sdEventIds = this._eventIds;
    window.__sdCommands = this._commands;
    window.__sdDispose = () => this._dispose(false);
  }

  onUnload() { this._dispose(true); }

  _dispose(fullUnload) {
    if (this._disposed) return;
    this._disposed = true;
    try { if (window.__sdInterval) clearInterval(window.__sdInterval); } catch (_) {}
    try { if (window.__sdFirstPass) clearTimeout(window.__sdFirstPass); } catch (_) {}
    try { for (const name of this._activityEvents || []) document.removeEventListener(name, this._activityHandler, true); } catch (_) {}
    try { for (const id of this._eventIds || []) this.events.off(id); } catch (_) {}
    try { for (const command of this._commands || []) command && command.remove && command.remove(); } catch (_) {}
    try { if (this._caretHandler) { document.removeEventListener('mouseup', this._caretHandler); document.removeEventListener('keyup', this._caretHandler); } } catch (_) {}
    try { if (this._caretPoll) clearInterval(this._caretPoll); } catch (_) {}
    try { if (this._hideObserver) this._hideObserver.disconnect(); } catch (_) {}
    try { if (this._hideNavId) this.events.off(this._hideNavId); } catch (_) {}
    try { if (this._tagCaretLineEl) this._tagCaretLineEl.classList.remove('sd-tag-caret-line'); } catch (_) {}
    try { if (this._statusItem && this._statusItem.remove) this._statusItem.remove(); } catch (_) {}
    try { if (typeof this._modalCancel === 'function') this._modalCancel(); } catch (_) {}
    for (const host of this._dashboardHosts || []) {
      try { if (host.root && host.click) host.root.removeEventListener('click', host.click); } catch (_) {}
      try { if (host.root && host.change) host.root.removeEventListener('change', host.change); } catch (_) {}
      try { if (host.root && host.input) host.root.removeEventListener('input', host.input); } catch (_) {}
    }
    this._dashboardHosts && this._dashboardHosts.clear();
    for (const waiter of this._quietWaiters || []) {
      try { clearTimeout(waiter.timer); waiter.resolve(false); } catch (_) {}
    }
    this._quietWaiters && this._quietWaiters.clear();
    try { if (window.__SD_SWEEP === this._sweepGlobal) delete window.__SD_SWEEP; } catch (_) {}
    try { if (window.__SD_DRY === this._dryGlobal) delete window.__SD_DRY; } catch (_) {}
    if (typeof window !== 'undefined' && window.__sdInstance === this) {
      for (const key of ['__sdDispose','__sdInterval','__sdFirstPass','__sdActivityHandler','__sdEventIds','__sdCommands','__sdCaretHandler','__sdCaretPoll','__sdStatusItem','__sdModalCancel','__sdPanelMount','__sdInstance','__sdHideObs','__sdHideNavId']) { try { delete window[key]; } catch (_) {} }
    }
    try { document.body && document.body.classList.remove('sd-hide-tags'); } catch (_) {}
    if (fullUnload) { try { document.getElementById(SD_STYLE_ID)?.remove(); } catch (_) {} }
  }

  _loadSettings() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SD_SETTINGS_KEY) || '{}') || {}; } catch (_) {}
    const merged = Object.assign({}, SD_DEFAULTS, stored);
    const defaultDelayMs = parseDuration(merged.defaultDelay);
    if (defaultDelayMs === null || defaultDelayMs === 0) {
      console.warn('[Self Destruct] Invalid zero or malformed defaultDelay; using ' + SD_DEFAULTS.defaultDelay);
      merged.defaultDelay = SD_DEFAULTS.defaultDelay;
    }
    const explicitBudget = Object.prototype.hasOwnProperty.call(stored, 'lineWriteBudget');
    const numericBudget = Number(merged.lineWriteBudget);
    if (explicitBudget && numericBudget === 0) {
      console.warn('[Self Destruct] lineWriteBudget 0 is unsafe; clamping to 1');
      merged.lineWriteBudget = 1;
    } else {
      const budget = Number.isFinite(numericBudget) ? numericBudget : SD_DEFAULTS.lineWriteBudget;
      merged.lineWriteBudget = Math.max(1, Math.min(SD_HARD_WRITE_CAP, Math.floor(budget)));
    }
    merged.dryRun = stored.dryRun === undefined ? true : stored.dryRun === true;
    merged.logEnabled = stored.logEnabled === undefined ? true : stored.logEnabled === true;
    merged.contentLog = stored.contentLog === undefined ? true : stored.contentLog === true;
    merged.hideTags = stored.hideTags === undefined ? true : stored.hideTags === true;
    merged.logCollection = String(merged.logCollection || SD_SCRATCHPAD_COLLECTION_GUID);
    return merged;
  }

  _loadResurrected() {
    const entries = [];
    const cutoff = Date.now() - SD_RESURRECTED_MAX_AGE_MS;
    try {
      const stored = JSON.parse(localStorage.getItem(SD_RESURRECTED_KEY) || '{}') || {};
      for (const [guid, value] of Object.entries(stored)) {
        const at = Number(value);
        if (guid && Number.isFinite(at) && at >= cutoff) entries.push([guid, at]);
      }
    } catch (_) {}
    entries.sort((a, b) => a[1] - b[1]);
    return new Map(entries.slice(-SD_RESURRECTED_LIMIT));
  }

  _markResurrected(guid) {
    if (!guid) return;
    const now = Date.now();
    const cutoff = now - SD_RESURRECTED_MAX_AGE_MS;
    this._resurrected.set(String(guid), now);
    const entries = Array.from(this._resurrected.entries())
      .filter(([, at]) => Number.isFinite(at) && at >= cutoff)
      .sort((a, b) => a[1] - b[1])
      .slice(-SD_RESURRECTED_LIMIT);
    this._resurrected = new Map(entries);
    const stored = {};
    for (const [entryGuid, at] of entries) stored[entryGuid] = at;
    try { localStorage.setItem(SD_RESURRECTED_KEY, JSON.stringify(stored)); } catch (_) {}
  }

  _initForensics() {
    if (!window.__SD_STATS || window.__SD_STATS.schemaVersion !== 1) {
      window.__SD_STATS = {
        schemaVersion: 1,
        reports: [],
        totals: { sweeps: 0, skipped: 0, writes: 0, failures: 0, deletedLines: 0, defused: 0 },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(window, '__SD_LAST_ERROR')) window.__SD_LAST_ERROR = null;
  }

  _subscribeUndeletes() {
    try {
      const id = this.events.on('lineitem.undeleted', event => {
        if (event && event.lineItemGuid) this._markResurrected(event.lineItemGuid);
      }, { collection: '*' });
      if (id) this._eventIds.push(id);
    } catch (error) { this._recordStandaloneError('subscribe', error, null, null); }
  }

  _installManagedStyle() {
    try {
      let style = document.getElementById(SD_STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = SD_STYLE_ID;
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = `
.sd-widget.sd-root { min-height:100%; box-sizing:border-box; padding:18px 20px 28px; background:var(--color-bg-900); color:var(--color-text-400); font-family:var(--font-family); }
.sd-widget .sd-shell { max-width:920px; margin:0 auto; }
.sd-widget .sd-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
.sd-widget .sd-title { font-size:20px; line-height:1.2; font-weight:750; }
.sd-widget .sd-meta { margin-top:5px; color:var(--color-text-600); font-size:11px; }
.sd-widget .sd-badge { display:inline-flex; align-items:center; min-height:24px; padding:2px 9px; border:1px solid var(--enum-yellow-border); border-radius:999px; background:var(--enum-yellow-bg); color:var(--enum-yellow-fg); font-size:11px; font-weight:800; letter-spacing:.05em; }
.sd-widget .sd-actions { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:16px; }
.sd-widget .sd-btn { border:1px solid var(--cards-border-color); border-radius:7px; padding:6px 10px; background:var(--button-bg-color); color:var(--color-text-400); font:inherit; font-size:12px; cursor:pointer; }
.sd-widget .sd-btn:hover,.sd-widget .sd-btn:focus-visible { border-color:var(--button-primary-bg-color); outline:none; }
.sd-widget .sd-btn-primary { border-color:var(--button-primary-bg-color); background:var(--button-primary-bg-color); color:var(--cards-bg); font-weight:650; }
.sd-widget .sd-btn-danger:hover,.sd-widget .sd-btn-danger:focus-visible { border-color:var(--enum-red-border); color:var(--enum-red-fg); }
.sd-widget .sd-banner { margin:7px 0; padding:8px 10px; border:1px solid var(--enum-yellow-border); border-radius:7px; background:var(--enum-yellow-bg); color:var(--enum-yellow-fg); font-size:12px; line-height:1.4; }
.sd-widget .sd-banner-error { border-color:var(--enum-red-border); background:var(--enum-red-bg); color:var(--enum-red-fg); }
.sd-widget .sd-section { margin-top:18px; }
.sd-widget .sd-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
.sd-widget .sd-section-title { font-size:13px; font-weight:750; text-transform:uppercase; letter-spacing:.05em; }
.sd-widget .sd-muted { color:var(--color-text-600); font-size:11px; }
.sd-widget .sd-list { display:grid; gap:7px; }
.sd-widget .sd-empty { padding:18px; border:1px dashed var(--cards-border-color); border-radius:9px; color:var(--color-text-600); text-align:center; font-size:12px; }
.sd-widget .sd-row { display:grid; grid-template-columns:minmax(116px,auto) minmax(0,1fr) auto; align-items:center; gap:11px; min-height:48px; padding:8px 10px; border:1px solid var(--cards-border-color); border-radius:9px; background:var(--cards-bg); }
.sd-widget .sd-row:hover { background:var(--sidebar-bg-hover); }
.sd-widget .sd-chip { justify-self:start; padding:3px 7px; border:1px solid var(--cards-border-color); border-radius:999px; color:var(--color-text-600); font-size:10px; font-weight:700; white-space:nowrap; }
.sd-widget .sd-row-main { min-width:0; }
.sd-widget .sd-crumb { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text-600); font-size:10px; }
.sd-widget .sd-line { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; font-size:12px; }
.sd-widget .sd-row-actions { display:flex; gap:5px; opacity:0; pointer-events:none; transition:opacity .1s; }
.sd-widget .sd-row:hover .sd-row-actions,.sd-widget .sd-row:focus-within .sd-row-actions { opacity:1; pointer-events:auto; }
.sd-widget .sd-row-actions .sd-btn { padding:4px 7px; font-size:10px; }
.sd-widget .sd-settings { display:grid; gap:10px; padding:13px; border:1px solid var(--cards-border-color); border-radius:9px; background:var(--cards-bg); }
.sd-widget .sd-setting { display:grid; grid-template-columns:minmax(150px,1fr) minmax(150px,260px); align-items:center; gap:14px; font-size:12px; }
.sd-widget .sd-input { width:100%; box-sizing:border-box; border:1px solid var(--cards-border-color); border-radius:6px; padding:6px 8px; background:var(--input-bg-color); color:var(--color-text-400); font:inherit; }
.sd-widget .sd-input:focus { border-color:var(--button-primary-bg-color); outline:none; }
.sd-widget .sd-input.sd-invalid { border-color:var(--enum-red-border); color:var(--enum-red-fg); }
.sd-widget .sd-toggle { justify-self:end; width:18px; height:18px; accent-color:var(--button-primary-bg-color); }
.sd-widget .sd-footnote { margin-top:2px; color:var(--color-text-600); font-size:10px; }
.sd-modal.sd-modal-overlay { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:20px; background:color-mix(in srgb,var(--color-bg-900) 78%,transparent); }
.sd-modal .sd-modal-card { width:min(390px,calc(100vw - 40px)); box-sizing:border-box; padding:16px; border:1px solid var(--cards-border-color); border-radius:10px; background:var(--cards-bg); color:var(--color-text-400); font-family:var(--font-family); }
.sd-modal .sd-modal-title { font-size:14px; font-weight:750; margin-bottom:6px; }
.sd-modal .sd-modal-note { color:var(--color-text-600); font-size:11px; margin-bottom:10px; }
.sd-modal .sd-modal-error { min-height:16px; margin-top:5px; color:var(--enum-red-fg); font-size:10px; }
.sd-modal .sd-modal-actions { display:flex; justify-content:flex-end; gap:7px; margin-top:8px; }
.sd-modal .sd-input { width:100%; box-sizing:border-box; border:1px solid var(--cards-border-color); border-radius:6px; padding:7px 9px; background:var(--input-bg-color); color:var(--color-text-400); font:inherit; }
.sd-modal .sd-input:focus { border-color:var(--button-primary-bg-color); outline:none; }
.sd-modal .sd-btn { border:1px solid var(--cards-border-color); border-radius:7px; padding:6px 11px; background:var(--button-bg-color); color:var(--color-text-400); font:inherit; font-size:12px; cursor:pointer; }
.sd-modal .sd-btn-primary { border-color:var(--button-primary-bg-color); background:var(--button-primary-bg-color); color:var(--cards-bg); font-weight:650; }
body.sd-hide-tags .sd-tag-hide { display:none; transition:none!important; }
body.sd-hide-tags .listitem:hover .sd-tag-hide,body.sd-hide-tags .listitem.listitem-with-caret .sd-tag-hide,body.sd-hide-tags .listitem.sd-tag-caret-line .sd-tag-hide,body.sd-hide-tags .flowythymer-thread-target .sd-tag-hide { display:inline; }
@media (max-width:620px) { .sd-widget .sd-header{display:block}.sd-widget .sd-badge{margin-top:10px}.sd-widget .sd-row{grid-template-columns:1fr}.sd-widget .sd-setting{grid-template-columns:1fr}.sd-widget .sd-toggle{justify-self:start} }
`;
    } catch (error) { this._recordStandaloneError('style', error, null, null); }
  }

  _installTagHiding() {
    window.__SD_HIDE_STATS = { stamped: 0, skippedTemplates: 0, fallbackSelectorUsed: false, lastScanMs: 0, scans: 0 };
    this._applyHideTags(false);
    try {
      this._hideObserver = new MutationObserver(mutations => this._onHideMutations(mutations));
      this._hideObserver.observe(document.body, { childList: true, subtree: true });
      window.__sdHideObs = this._hideObserver;
    } catch (error) { this._recordStandaloneError('hide-tags-observer', error, null, null); }
    try {
      this._hideNavId = this.events.on('panel.navigated', () => this._scanSdChips(document));
      if (this._hideNavId) {
        this._eventIds.push(this._hideNavId);
        window.__sdHideNavId = this._hideNavId;
      }
    } catch (error) { this._recordStandaloneError('hide-tags-navigation', error, null, null); }
    this._refreshTemplateGuids().catch(error => this._recordStandaloneError('hide-tags-templates', error, null, null));
  }

  _applyHideTags(scan) {
    try { this._setClassState(document.body, 'sd-hide-tags', !!this._settings.hideTags); } catch (_) {}
    if (scan && this._settings.hideTags) this._scanSdChips(document);
  }

  _setClassState(element, className, enabled) {
    if (!element || !element.classList) return false;
    const hasClass = element.classList.contains(className);
    if (hasClass === !!enabled) return false;
    if (enabled) element.classList.add(className);
    else element.classList.remove(className);
    return true;
  }

  async _refreshTemplateGuids() {
    const templateGuids = new Set();
    const collections = await this.data.getAllCollections();
    const templates = (collections || []).find(collection => {
      try { return collection.getGuid() === SD_TEMPLATES_COLLECTION_GUID; } catch (_) { return false; }
    });
    if (templates) {
      for (const record of await templates.getAllRecords()) if (record && record.guid) templateGuids.add(record.guid);
    }
    this._adoptTemplateGuids(templateGuids);
    return templateGuids;
  }

  _adoptTemplateGuids(templateGuids) {
    this._templateGuids = new Set(templateGuids || []);
    this._templateGuidsReady = true;
    this._scanSdChips(document);
  }

  _findSdChips(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const primaryNodes = [];
    if (rootEl.nodeType === 1 && rootEl.matches('.lineitem-hashtag')) primaryNodes.push(rootEl);
    for (const element of rootEl.querySelectorAll('.lineitem-hashtag')) primaryNodes.push(element);
    if (primaryNodes.length) {
      this._lastFindUsedFallback = false;
      return primaryNodes.filter(element => matchesSdTagText(element.textContent));
    }

    const fallback = [];
    const considerLeaf = element => {
      if (!element || element.nodeType !== 1 || element.childElementCount !== 0) return;
      if (!element.closest('.listitem') || !matchesSdTagText(element.textContent)) return;
      fallback.push(element);
    };
    considerLeaf(rootEl);
    for (const element of rootEl.querySelectorAll('*')) considerLeaf(element);
    this._lastFindUsedFallback = true;
    return fallback;
  }

  _scanSdChips(rootEl) {
    const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let stamped = 0;
    let skippedTemplates = 0;
    let fallbackSelectorUsed = false;
    try {
      if (!this._templateGuidsReady) return;
      const chips = this._findSdChips(rootEl);
      fallbackSelectorUsed = this._lastFindUsedFallback === true;
      for (const chip of chips) {
        const record = chip.closest('.listview-items[data-guid]');
        const recordGuid = record && record.getAttribute('data-guid');
        if (recordGuid && this._templateGuids.has(recordGuid)) {
          this._setClassState(chip, 'sd-tag-hide', false);
          skippedTemplates++;
          continue;
        }
        this._setClassState(chip, 'sd-tag-hide', true);
        stamped++;
      }
    } finally {
      const finishedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const stats = window.__SD_HIDE_STATS || { stamped: 0, skippedTemplates: 0, fallbackSelectorUsed: false, lastScanMs: 0, scans: 0 };
      stats.stamped = stamped;
      stats.skippedTemplates = skippedTemplates;
      stats.fallbackSelectorUsed = fallbackSelectorUsed;
      stats.lastScanMs = Math.max(0, finishedAt - startedAt);
      stats.scans = Number(stats.scans || 0) + 1;
      window.__SD_HIDE_STATS = stats;
    }
  }

  _hideMutationRoot(node) {
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!element) return null;
    if (element.matches('.listitem') || element.closest('.listitem')) return element;
    return null;
  }

  _onHideMutations(mutations) {
    if (!this._templateGuidsReady) return;
    const roots = new Set();
    for (const mutation of mutations || []) {
      const target = this._hideMutationRoot(mutation.target);
      if (target) roots.add(target);
      for (const node of mutation.addedNodes || []) {
        const added = this._hideMutationRoot(node);
        if (added) roots.add(added);
      }
    }
    for (const root of roots) this._scanSdChips(root);
  }

  _registerDashboard() {
    try {
      window.__sdPanelMount = panel => {
        const current = window.__sdInstance;
        if (current && !current._disposed) current._mountDashboard(panel);
      };
      this.ui.registerCustomPanelType('self-destruct', panel => window.__sdPanelMount && window.__sdPanelMount(panel));
    } catch (error) { this._recordStandaloneError('panel-register', error, null, null); }
    try {
      this._statusItem = this.ui.addStatusBarItem({
        label: 'Self Destruct',
        icon: 'ti-trash',
        tooltip: 'Open Self Destruct dashboard',
        onClick: () => this.openDashboard(),
      });
      window.__sdStatusItem = this._statusItem;
    } catch (error) { this._recordStandaloneError('status-bar', error, null, null); }
    try {
      for (const root of document.querySelectorAll('.sd-widget.sd-root')) this._bindDashboardRoot(root, null);
    } catch (_) {}
  }

  _mountDashboard(panel) {
    try { panel.setTitle('Self Destruct'); } catch (_) {}
    const host = panel && panel.getElement && panel.getElement();
    if (!host) return;
    host.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'sd-widget sd-root';
    root.style.background = 'var(--color-bg-900)';
    host.appendChild(root);
    this._bindDashboardRoot(root, panel);
    this._refreshDashboard().catch(() => {});
  }

  _bindDashboardRoot(root, panel) {
    if (!root || root.__sdDashboardBound === this) return;
    const prior = root.__sdDashboardHost;
    if (prior && prior.click) try { root.removeEventListener('click', prior.click); } catch (_) {}
    if (prior && prior.change) try { root.removeEventListener('change', prior.change); } catch (_) {}
    if (prior && prior.input) try { root.removeEventListener('input', prior.input); } catch (_) {}
    const entry = { root, panel, scanning: false, click: null, change: null, input: null };
    entry.click = event => this._onDashboardClick(event, entry);
    entry.change = event => this._onDashboardChange(event);
    entry.input = event => this._onDashboardInput(event);
    root.addEventListener('click', entry.click);
    root.addEventListener('change', entry.change);
    root.addEventListener('input', entry.input);
    root.__sdDashboardBound = this;
    root.__sdDashboardHost = entry;
    root.style.background = 'var(--color-bg-900)';
    this._dashboardHosts.add(entry);
    this._renderDashboard(entry);
  }

  _escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  }

  _formatTime24(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return 'never';
    const date = new Date(value);
    const pad = part => String(part).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  _lastSweepReport() {
    try {
      const reports = window.__SD_STATS && window.__SD_STATS.reports;
      return reports && reports.length ? reports[reports.length - 1] : null;
    } catch (_) { return null; }
  }

  _pendingVerdicts() {
    const verdicts = this._dashboardReport && this._dashboardReport.schemaVersion === 1 ? this._dashboardReport.verdicts || [] : [];
    const statuses = new Set(['wait','delete','defuse','keep','malformed','no-ts']);
    return verdicts.filter(verdict => verdict && (statuses.has(verdict.status) || verdict.deferred === true)).slice().sort((left, right) => {
      const actionable = verdict => verdict.status === 'delete' || verdict.status === 'defuse' || verdict.deferred === true ? 0 : 1;
      const rank = actionable(left) - actionable(right);
      if (rank) return rank;
      const leftDeadline = Number.isFinite(left.deadline) ? left.deadline : Number.POSITIVE_INFINITY;
      const rightDeadline = Number.isFinite(right.deadline) ? right.deadline : Number.POSITIVE_INFINITY;
      if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
      return String(left.recordName || '').localeCompare(String(right.recordName || ''));
    });
  }

  _verdictLabel(verdict) {
    if (verdict.deferred) return 'next sweep';
    if (verdict.status === 'wait') return formatCountdown(verdict.remainingMs);
    if (verdict.status === 'delete') return 'next sweep';
    if (verdict.status === 'defuse') return 'defuses (has content)';
    if (verdict.status === 'keep') return 'kept (#keep)';
    if (verdict.status === 'malformed') return 'malformed';
    if (verdict.status === 'no-ts') return 'no timestamp';
    return verdict.status || 'unknown';
  }

  _renderDashboard(entry) {
    if (!entry || !entry.root || !entry.root.isConnected) return;
    const last = this._lastSweepReport();
    const report = this._dashboardReport;
    const verdicts = this._pendingVerdicts();
    const lastText = last ? this._formatTime24(last.finishedAt || last.startedAt) + ' · ' + String(last.durationMs == null ? 0 : last.durationMs) + ' ms' : 'never';
    const banners = [];
    if (report && report.searchCapped) banners.push('Search reached its result cap; some tagged lines may be missing.');
    if (report && report.capped) banners.push('The line-write budget deferred work to the next sweep.');
    if (report && report.truncated) banners.push('The sweep was truncated before every candidate was evaluated.');
    if (report && report.circuitBroken) banners.push('Circuit breaker stopped the sweep: ' + String(report.circuitReason || 'unknown reason') + '.');
    try { if (window.__SD_STATS && window.__SD_STATS.panelBanner) banners.push(String(window.__SD_STATS.panelBanner.message || window.__SD_STATS.panelBanner)); } catch (_) {}
    let errorBanner = '';
    try {
      const error = window.__SD_LAST_ERROR;
      if (error) errorBanner = '<div class="sd-banner sd-banner-error">Last error · ' + this._escapeHtml(this._formatTime24(error.ts)) + ' · ' + this._escapeHtml(error.phase) + ': ' + this._escapeHtml(error.message) + '</div>';
    } catch (_) {}
    const rows = verdicts.map(verdict => '<div class="sd-row" data-line-guid="' + this._escapeHtml(verdict.lineGuid) + '">' +
      '<span class="sd-chip">' + this._escapeHtml(this._verdictLabel(verdict)) + '</span>' +
      '<div class="sd-row-main"><div class="sd-crumb">› ' + this._escapeHtml(verdict.recordName || 'Untitled') + '</div><div class="sd-line" title="' + this._escapeHtml(verdict.text || '') + '">' + this._escapeHtml(verdict.text || '(empty line)') + '</div></div>' +
      '<div class="sd-row-actions"><button class="sd-btn" type="button" data-sd-action="open">Open</button><button class="sd-btn" type="button" data-sd-action="defuse">Defuse</button><button class="sd-btn sd-btn-danger" type="button" data-sd-action="trash">Trash now</button></div></div>').join('');
    entry.root.innerHTML = '<div class="sd-shell">' +
      '<div class="sd-header"><div><div class="sd-title">Self Destruct</div><div class="sd-meta">v' + SD_VERSION + ' · Last sweep ' + this._escapeHtml(lastText) + '</div></div>' +
      (this._settings.dryRun ? '<span class="sd-badge">DRY RUN ON</span>' : '') + '</div>' +
      '<div class="sd-actions"><button class="sd-btn sd-btn-primary" type="button" data-sd-action="sweep">Sweep now</button><button class="sd-btn" type="button" data-sd-action="dry">Dry-run sweep</button><button class="sd-btn" type="button" data-sd-action="refresh">Refresh</button></div>' +
      banners.map(text => '<div class="sd-banner">' + this._escapeHtml(text) + '</div>').join('') + errorBanner +
      '<section class="sd-section"><div class="sd-section-head"><div class="sd-section-title">Pending</div><div class="sd-muted">' + (entry.scanning ? 'Scanning…' : verdicts.length + ' line' + (verdicts.length === 1 ? '' : 's')) + '</div></div>' +
      '<div class="sd-list">' + (rows || '<div class="sd-empty">' + (report ? 'No pending self-destruct lines.' : 'Scanning for tagged lines…') + '</div>') + '</div></section>' +
      '<section class="sd-section"><div class="sd-section-head"><div class="sd-section-title">Settings</div></div><div class="sd-settings">' +
      '<label class="sd-setting"><span>Default delay</span><input class="sd-input" name="defaultDelay" type="text" value="' + this._escapeHtml(this._settings.defaultDelay) + '" spellcheck="false" aria-label="Default delay"></label>' +
      '<label class="sd-setting"><span>Line-write budget</span><input class="sd-input" name="lineWriteBudget" type="number" min="1" max="' + SD_HARD_WRITE_CAP + '" value="' + this._escapeHtml(this._settings.lineWriteBudget) + '"></label>' +
      '<label class="sd-setting"><span>Dry-run by default</span><input class="sd-toggle" name="dryRun" type="checkbox" ' + (this._settings.dryRun ? 'checked' : '') + '></label>' +
      '<label class="sd-setting"><span>Hide #sd tags in documents</span><input class="sd-toggle" name="hideTags" type="checkbox" ' + (this._settings.hideTags ? 'checked' : '') + '></label>' +
      '<label class="sd-setting"><span>Log enabled</span><input class="sd-toggle" name="logEnabled" type="checkbox" ' + (this._settings.logEnabled ? 'checked' : '') + '></label>' +
      '<label class="sd-setting"><span>Include deleted content in log</span><input class="sd-toggle" name="contentLog" type="checkbox" ' + (this._settings.contentLog ? 'checked' : '') + '></label>' +
      '<label class="sd-setting"><span>Log collection GUID</span><input class="sd-input" name="logCollection" type="text" value="' + this._escapeHtml(this._settings.logCollection) + '" spellcheck="false"></label>' +
      '<div class="sd-footnote">Settings are per-device (localStorage).</div></div></section></div>';
  }

  _paintDashboards() {
    for (const entry of Array.from(this._dashboardHosts || [])) {
      if (!entry.root || !entry.root.isConnected) { this._dashboardHosts.delete(entry); continue; }
      this._renderDashboard(entry);
    }
  }

  async _refreshDashboard() {
    if (this._dashboardRefreshPromise) return this._dashboardRefreshPromise;
    for (const entry of this._dashboardHosts) entry.scanning = true;
    this._paintDashboards();
    this._dashboardRefreshPromise = (async () => {
      while (this._running && !this._disposed) await sleep(50);
      if (this._disposed) return null;
      const report = await this._requestSweep({ manual: true, dryRun: true, source: 'dry-run' });
      if (report && report.schemaVersion === 1 && report.dryRun === true) this._dashboardReport = report;
      return report;
    })().catch(error => {
      this._recordStandaloneError('dashboard-refresh', error, null, null);
      return null;
    }).finally(() => {
      for (const entry of this._dashboardHosts) entry.scanning = false;
      this._dashboardRefreshPromise = null;
      this._paintDashboards();
    });
    return this._dashboardRefreshPromise;
  }

  _saveSettings(patch) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SD_SETTINGS_KEY) || '{}') || {}; } catch (_) {}
    const next = Object.assign({}, stored, patch || {});
    try { localStorage.setItem(SD_SETTINGS_KEY, JSON.stringify(next)); } catch (error) { this._recordStandaloneError('settings-save', error, null, null); return false; }
    Object.assign(this._settings, patch || {});
    return true;
  }

  _onDashboardInput(event) {
    const input = event.target;
    if (!input || input.name !== 'defaultDelay') return;
    const value = String(input.value || '').trim().toLowerCase();
    const valid = parseDuration(value);
    const invalid = valid === null || valid === 0;
    input.classList.toggle('sd-invalid', invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    if (!invalid) this._saveSettings({ defaultDelay: value });
  }

  _onDashboardChange(event) {
    const input = event.target;
    if (!input || !input.name) return;
    if (input.name === 'lineWriteBudget') {
      const budget = Math.floor(Number(input.value));
      if (!Number.isFinite(budget) || budget < 1) { input.classList.add('sd-invalid'); return; }
      input.classList.remove('sd-invalid');
      const clamped = Math.min(SD_HARD_WRITE_CAP, budget);
      input.value = String(clamped);
      this._saveSettings({ lineWriteBudget: clamped });
      return;
    }
    if (input.name === 'logCollection') {
      const guid = String(input.value || '').trim();
      if (guid) this._saveSettings({ logCollection: guid });
      return;
    }
    if (['dryRun','hideTags','logEnabled','contentLog'].includes(input.name)) {
      this._saveSettings({ [input.name]: !!input.checked });
      if (input.name === 'hideTags') this._applyHideTags(true);
      this._paintDashboards();
    }
  }

  async _onDashboardClick(event) {
    const button = event.target && event.target.closest && event.target.closest('[data-sd-action]');
    if (!button) return;
    const action = button.getAttribute('data-sd-action');
    if (action === 'refresh') { await this._refreshDashboard(); return; }
    if (action === 'sweep' || action === 'dry') {
      try {
        const report = await this._requestSweep({ manual: true, dryRun: action === 'dry' ? true : !!this._settings.dryRun, source: action === 'dry' ? 'dry-run' : 'manual' });
        if (report && report.dryRun) this._dashboardReport = report;
      } catch (_) {}
      this._paintDashboards();
      if (action === 'sweep' && !this._settings.dryRun) await this._refreshDashboard();
      return;
    }
    const row = button.closest('.sd-row[data-line-guid]');
    const lineGuid = row && row.getAttribute('data-line-guid');
    const verdict = this._pendingVerdicts().find(item => item.lineGuid === lineGuid);
    if (!verdict) return;
    if (action === 'open') { await this._openVerdict(verdict); return; }
    if (action === 'defuse') await this.defuseLine(verdict.recordGuid, verdict.lineGuid);
    if (action === 'trash') await this.trashLineNow(verdict.recordGuid, verdict.lineGuid);
    this._dashboardReport = null;
    this._paintDashboards();
    await this._refreshDashboard();
  }

  async _openVerdict(verdict) {
    try {
      const active = this.ui.getActivePanel();
      if (!active) { this.openRecordInThisPanel(verdict.recordGuid); return; }
      const found = await active.navigateTo({ itemGuid: verdict.lineGuid, highlight: true });
      if (!found) this.openRecordInThisPanel(verdict.recordGuid);
    } catch (error) { this._recordStandaloneError('open-line', error, verdict.lineGuid, verdict.recordGuid); }
  }

  openRecordInThisPanel(recordGuid) {
    if (!recordGuid) return false;
    const panel = this.ui.getActivePanel();
    if (!panel) return false;
    try {
      panel.navigateTo({ type: 'edit_panel', rootId: recordGuid, workspaceGuid: this.getWorkspaceGuid() });
      return true;
    } catch (error) { this._recordStandaloneError('open-record', error, null, recordGuid); return false; }
  }

  async openDashboard() {
    const source = this.ui.getActivePanel();
    try {
      const created = await this.ui.createPanel({ afterPanel: source });
      if (created) { created.navigateToCustomType('self-destruct'); return true; }
      const panels = Array.from(this.ui.getPanels() || []);
      const panelId = panel => { try { return panel && panel.getId && panel.getId(); } catch (_) { return undefined; } };
      const sourceId = panelId(source);
      let reuse = null;
      const sourceIndex = panels.findIndex(panel => sourceId !== undefined ? panelId(panel) === sourceId : panel === source);
      if (sourceIndex >= 0 && panels.length > 1) reuse = panels[(sourceIndex + 1) % panels.length];
      if (!reuse || reuse === source) reuse = panels.find(panel => panel !== source) || null;
      if (reuse) { reuse.navigateToCustomType('self-destruct'); return true; }
      const warning = { ts: Date.now(), stage: 'createPanel:null', panelCount: panels.length, message: 'Could not open dashboard: panel cap reached and no adjacent panel was reusable.' };
      if (window.__SD_STATS) window.__SD_STATS.panelBanner = warning;
      console.warn('[Self Destruct]', warning.message, warning);
      this._paintDashboards();
      return false;
    } catch (error) {
      this._recordStandaloneError('open-dashboard', error, null, null);
      return false;
    }
  }

  _registerCommands() {
    try {
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Self Destruct: Dashboard',
        icon: 'ti-layout-dashboard',
        onSelected: () => { this.openDashboard().catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Self Destruct: Sweep now',
        icon: 'ti-trash',
        onSelected: () => { this._requestSweep({ manual: true, dryRun: !!this._settings.dryRun, source: 'manual' }).catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Self Destruct: Dry-run sweep',
        icon: 'ti-eye',
        onSelected: () => { this._requestSweep({ manual: true, dryRun: true, source: 'dry-run' }).catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Self Destruct: Toggle tag hiding',
        icon: 'ti-eye-off',
        onSelected: () => {
          this._saveSettings({ hideTags: !this._settings.hideTags });
          this._applyHideTags(true);
          this._paintDashboards();
        },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Tag current line: #sd',
        icon: 'ti-tag',
        onSelected: () => { this._tagCurrentLine('#sd').catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Tag current line: #sd/empty',
        icon: 'ti-tag',
        onSelected: () => { this._tagCurrentLine('#sd/empty').catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Tag current line with delay…',
        icon: 'ti-clock',
        onSelected: () => { this._tagCurrentLineWithDelay().catch(() => {}); },
      }));
      this._commands.push(this.ui.addCommandPaletteCommand({
        label: 'Defuse current line',
        icon: 'ti-shield-off',
        onSelected: () => { this._defuseCurrentLine().catch(() => {}); },
      }));
    } catch (error) { this._recordStandaloneError('commands', error, null, null); }
  }

  _installCaretStash() {
    this._caretHandler = () => this._stashCaretGuid();
    try {
      document.addEventListener('mouseup', this._caretHandler);
      document.addEventListener('keyup', this._caretHandler);
      this._caretPoll = setInterval(() => this._stashCaretGuid(), SD_CARET_POLL_MS);
      window.__sdCaretHandler = this._caretHandler;
      window.__sdCaretPoll = this._caretPoll;
      this._stashCaretGuid();
    } catch (error) { this._recordStandaloneError('caret-stash', error, null, null); }
  }

  _stashCaretGuid() {
    if (this._disposed) return null;
    const guid = this._currentCaretGuid();
    this._syncTagCaretLine(guid);
    if (!guid) return null;
    this._caretStash = { guid: String(guid), ts: Date.now() };
    return this._caretStash;
  }

  _syncTagCaretLine(guid) {
    const nextGuid = guid ? String(guid) : null;
    if (this._tagCaretLineGuid === nextGuid
        && (!nextGuid || (this._tagCaretLineEl && this._tagCaretLineEl.isConnected !== false))) return;
    let next = null;
    if (nextGuid) {
      try { next = document.querySelector('.listitem[data-guid="' + CSS.escape(nextGuid) + '"]'); } catch (_) {}
    }
    if (this._tagCaretLineEl && this._tagCaretLineEl !== next) {
      try { this._setClassState(this._tagCaretLineEl, 'sd-tag-caret-line', false); } catch (_) {}
    }
    if (next) {
      try { this._setClassState(next, 'sd-tag-caret-line', true); } catch (_) {}
    }
    this._tagCaretLineEl = next;
    this._tagCaretLineGuid = nextGuid;
  }

  _stashedCaretGuid() {
    this._stashCaretGuid();
    const stash = this._caretStash;
    if (!stash || !stash.guid || Date.now() - stash.ts > SD_CARET_STASH_MAX_AGE_MS) return null;
    return stash.guid;
  }

  async _caretLine() {
    const lineGuid = this._stashedCaretGuid();
    if (!lineGuid) return null;
    let lineElement = null;
    try { lineElement = document.querySelector('.listitem[data-guid="' + CSS.escape(lineGuid) + '"]'); } catch (_) {}
    const recordElement = lineElement && lineElement.closest('.listview-items[data-guid]');
    const recordGuid = recordElement && recordElement.getAttribute('data-guid');
    if (!recordGuid) return null;
    const record = this.data.getRecord(recordGuid);
    if (!record) return null;
    const lines = await record.getLineItems(false);
    const line = (lines || []).find(item => item && item.guid === lineGuid) || null;
    return line ? { line, lineGuid, record, recordGuid } : null;
  }

  _toast(title, message) {
    try { this.ui.addToaster({ title, message, dismissible: true, autoDestroyTime: 2200 }); } catch (_) {}
  }

  async _tagCurrentLine(tag) {
    const target = await this._caretLine();
    if (!target) { this._toast('Self Destruct', 'Click into a line first.'); return false; }
    const next = [];
    let replaced = false;
    for (const segment of target.line.segments || []) {
      if (segment && segment.type === 'hashtag' && typeof segment.text === 'string' && SD_TAG_RE.test(segment.text)) {
        if (!replaced) { next.push({ type: 'hashtag', text: tag }); replaced = true; }
        continue;
      }
      next.push(segment);
    }
    if (!replaced) next.push({ type: 'text', text: ' ' }, { type: 'hashtag', text: tag });
    const ok = await target.line.setSegments(next);
    if (!ok) throw new Error('setSegments returned false');
    this._dashboardReport = null;
    this._toast('Self Destruct', 'Tagged current line ' + tag + '.');
    this._paintDashboards();
    return true;
  }

  async _tagCurrentLineWithDelay() {
    const delay = await this._showDelayModal();
    if (!delay) return false;
    return await this._tagCurrentLine('#sd/' + delay);
  }

  _showDelayModal() {
    if (typeof this._modalCancel === 'function') this._modalCancel();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'sd-modal sd-modal-overlay';
      overlay.innerHTML = '<form class="sd-modal-card"><div class="sd-modal-title">Self-destruct delay</div><div class="sd-modal-note">Enter a duration such as 30m, 12h, 3d, or 2w.</div><input class="sd-input" type="text" autocomplete="off" spellcheck="false" aria-label="Self-destruct delay"><div class="sd-modal-error" role="alert"></div><div class="sd-modal-actions"><button class="sd-btn" type="button" data-modal-cancel>Cancel</button><button class="sd-btn sd-btn-primary" type="submit">OK</button></div></form>';
      const form = overlay.querySelector('form');
      const input = overlay.querySelector('input');
      const error = overlay.querySelector('.sd-modal-error');
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (window.__sdModalCancel === cancel) delete window.__sdModalCancel;
        if (this._modalCancel === cancel) this._modalCancel = null;
        resolve(value);
      };
      const cancel = () => finish(null);
      const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
      form.addEventListener('submit', event => {
        event.preventDefault();
        const value = String(input.value || '').trim().toLowerCase();
        const parsed = parseDuration(value);
        if (parsed === null || parsed === 0) { error.textContent = 'Use a positive duration: 30m, 12h, 3d, or 2w.'; input.classList.add('sd-invalid'); input.focus(); return; }
        finish(value);
      });
      overlay.querySelector('[data-modal-cancel]').addEventListener('click', cancel);
      overlay.addEventListener('mousedown', event => { if (event.target === overlay) cancel(); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      this._modalCancel = cancel;
      window.__sdModalCancel = cancel;
      setTimeout(() => input.focus(), 0);
    });
  }

  async _defuseCurrentLine() {
    const target = await this._caretLine();
    if (!target) { this._toast('Self Destruct', 'Click into a line first.'); return false; }
    const result = await this.defuseLine(target.recordGuid, target.lineGuid);
    if (result) this._toast('Self Destruct', 'Current line defused.');
    else this._toast('Self Destruct', 'The line no longer has a self-destruct tag.');
    return result;
  }

  _recordStandaloneError(phase, error, lineGuid, recordGuid) {
    const item = {
      ts: Date.now(),
      phase,
      lineGuid: lineGuid || null,
      recordGuid: recordGuid || null,
      message: String(error && error.message || error || 'Unknown error'),
      stack: String(error && error.stack || ''),
    };
    try { window.__SD_LAST_ERROR = item; } catch (_) {}
    console.error('[Self Destruct][' + phase + ']', error);
    return item;
  }

  _reportError(report, phase, error, lineGuid, recordGuid) {
    const item = this._recordStandaloneError(phase, error, lineGuid, recordGuid);
    report.errors.push(item);
    report.counts.error++;
    return item;
  }

  _nativeOverlayVisible() {
    try {
      if (document.body && document.body.classList.contains('is-ac-menu-open')) return true;
      const selectors = '.cmdpal--inline,.cmdpal-inline,.cmdpal--dialog,.omni-overlay,[role="dialog"]';
      for (const node of Array.from(document.querySelectorAll(selectors))) {
        if (!node || node.isConnected === false || node.hidden || node.getAttribute('aria-hidden') === 'true') continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (node.getClientRects().length) return true;
      }
    } catch (_) {}
    return false;
  }

  _inputPending() {
    try { return !!(navigator.scheduling && navigator.scheduling.isInputPending && navigator.scheduling.isInputPending({ includeContinuous: true })); } catch (_) { return false; }
  }

  async _quietTick(ms) {
    if (this._disposed) return false;
    return await new Promise(resolve => {
      const waiter = { timer: null, resolve };
      waiter.timer = setTimeout(() => { this._quietWaiters.delete(waiter); resolve(!this._disposed); }, ms);
      this._quietWaiters.add(waiter);
    });
  }

  async _waitForEditorQuiet() {
    const gateStartedAt = Date.now();
    const recordBlockedGate = () => {
      const gateBlockedMs = Date.now() - gateStartedAt;
      if (gateBlockedMs <= 3 * 60000) return;
      try { if (window.__SD_STATS) window.__SD_STATS.gateBlockedMs = gateBlockedMs; } catch (_) {}
    };
    let overlayWasOpen = false;
    while (!this._disposed) {
      if (this._nativeOverlayVisible() || this._inputPending()) {
        recordBlockedGate();
        overlayWasOpen = true;
        this._lastActivityAt = Date.now();
        if (!await this._quietTick(SD_EDITOR_POLL_MS)) return false;
        continue;
      }
      if (overlayWasOpen) {
        overlayWasOpen = false;
        this._lastActivityAt = Date.now();
      }
      if (Date.now() - this._lastActivityAt >= SD_EDITOR_QUIET_MS) return true;
      recordBlockedGate();
      if (!await this._quietTick(SD_EDITOR_POLL_MS)) return false;
    }
    return false;
  }

  _currentCaretGuid() {
    const domHas = guid => {
      if (!guid || typeof document === 'undefined') return null;
      try { return document.querySelector('.listitem[data-guid="' + CSS.escape(String(guid)) + '"]') ? String(guid) : null; } catch (_) { return null; }
    };
    try {
      const rangeGuid = window.g_range && window.g_range.first_pos && window.g_range.first_pos.list_item && window.g_range.first_pos.list_item.state && window.g_range.first_pos.list_item.state.guid;
      const found = domHas(rangeGuid); if (found) return found;
    } catch (_) {}
    try {
      const itemGuid = window.g_item && window.g_item.state && window.g_item.state.guid;
      const found = domHas(itemGuid); if (found) return found;
    } catch (_) {}
    try {
      const legacy = document.querySelector('.listitem.listitem-with-caret[data-guid]');
      if (legacy) return legacy.getAttribute('data-guid');
      const thread = document.querySelector('.flowythymer-thread-target');
      const line = thread && thread.closest('.listitem[data-guid]');
      return line ? line.getAttribute('data-guid') : null;
    } catch (_) { return null; }
  }

  _newActionContext(kind) {
    const report = newReport({ source: 'manual', dryRun: false });
    return {
      report,
      writeAttempts: 0,
      actionWrites: 0,
      attemptedSubtrees: 0,
      consecutiveDeleteFailures: 0,
      stopped: false,
      logCache: { resolved: false, record: null },
      kind,
    };
  }

  async _minimalDiscovery(context) {
    const templateRecords = new Set();
    const collections = await this.data.getAllCollections();
    const templates = (collections || []).find(collection => {
      try { return collection.getGuid() === SD_TEMPLATES_COLLECTION_GUID; } catch (_) { return false; }
    });
    if (templates) {
      for (const record of await templates.getAllRecords()) if (record && record.guid) templateRecords.add(record.guid);
    }
    this._adoptTemplateGuids(templateRecords);
    const logRecord = await this._findLogRecord(false, context);
    return { lines: [], searchCapped: false, templateRecords, logGuid: logRecord && logRecord.guid || null };
  }

  async _freshLineByGuid(recordGuid, lineGuid) {
    if (!recordGuid || !lineGuid) return null;
    const record = this.data.getRecord(recordGuid);
    if (!record || this._isTrashed(record)) return null;
    const lines = await record.getLineItems(false);
    return (lines || []).find(line => line && line.guid === lineGuid) || null;
  }

  async defuseLine(recordGuid, lineGuid) {
    const context = this._newActionContext('manual-defuse');
    try {
      const line = await this._freshLineByGuid(recordGuid, lineGuid);
      if (!line) return false;
      const discovery = await this._minimalDiscovery(context);
      const result = await this._defuse(line, discovery, context, { manual: true, ignoreCaret: true });
      return !!(result && result.action && result.action.ok);
    } catch (error) {
      this._recordStandaloneError('manual-defuse', error, lineGuid, recordGuid);
      return false;
    }
  }

  async trashLineNow(recordGuid, lineGuid) {
    const context = this._newActionContext('manual-trash');
    try {
      const line = await this._freshLineByGuid(recordGuid, lineGuid);
      if (!line) {
        this._toast('Self Destruct', 'Trash now was blocked: line not found.');
        return false;
      }
      const discovery = await this._minimalDiscovery(context);
      const result = await this._destroyLine(line, discovery, context, { bypassExpiry: true, ignoreCaret: true });
      if (!result.completed) {
        const verdict = result && result.verdict;
        const reason = verdict && verdict.reason;
        const status = verdict && verdict.status;
        const detail = status === 'keep' || reason === 'keep-veto'
          ? '#keep in subtree'
          : reason === 'missing'
            ? 'line not found'
            : 'safety check (' + String(status || 'skip') + ': ' + String(reason || 'unknown') + ')';
        this._toast('Self Destruct', 'Trash now was blocked: ' + detail + '.');
      }
      return !!result.completed;
    } catch (error) {
      this._recordStandaloneError('manual-trash', error, lineGuid, recordGuid);
      return false;
    }
  }

  _requestSweep(options) {
    if (this._disposed) return Promise.resolve(null);
    if (this._running) {
      this._pendingRerun = Object.assign({}, options);
      return this._sweepPromise;
    }
    this._running = true;
    this._sweepPromise = this._runSweep(options).catch(error => {
      this._recordStandaloneError('sweep', error, null, null);
      throw error;
    }).finally(() => {
      this._running = false;
      const pending = this._pendingRerun;
      this._pendingRerun = null;
      this._sweepPromise = null;
      if (pending && !this._disposed) setTimeout(() => this._requestSweep(pending).catch(() => {}), 0);
    });
    return this._sweepPromise;
  }

  async _runSweep(options) {
    const report = newReport(options);
    const context = {
      report,
      writeAttempts: 0,
      actionWrites: 0,
      attemptedSubtrees: 0,
      consecutiveDeleteFailures: 0,
      stopped: false,
      logCache: { resolved: false, record: null },
    };
    try {
      let workspaceGuid = null;
      try { workspaceGuid = this.getWorkspaceGuid(); } catch (_) {}
      if (workspaceGuid !== SD_WORKSPACE_GUID) {
        report.skipped = true; report.skipReason = 'wrong-workspace'; return this._finishReport(report, context);
      }
      if (!await this._waitForEditorQuiet()) {
        report.skipped = true; report.skipReason = 'disposed'; return this._finishReport(report, context);
      }
      if (!options.manual && await this._hasRecentLogSummary(context)) {
        report.skipped = true; report.skipReason = 'multi-client'; return this._finishReport(report, context);
      }

      const discovery = await this._discover(report, context);
      report.searchCapped = discovery.searchCapped;
      report.candidates = discovery.lines.length;
      const evaluated = [];
      for (let index = 0; index < discovery.lines.length; index++) {
        if (index && index % SD_BATCH_SIZE === 0 && !await this._waitForEditorQuiet()) {
          report.truncated = true;
          report.skipReason = 'quiet-gate-abort';
          break;
        }
        const line = discovery.lines[index];
        try { evaluated.push({ line, verdict: await this._evaluateLine(line, discovery, Date.now()) }); }
        catch (error) {
          const record = this._lineRecord(line);
          this._reportError(report, 'verdict', error, line && line.guid, record && record.guid);
          evaluated.push({ line, verdict: this._baseSkip(line, 'error') });
        }
      }
      evaluated.sort((a, b) => a.verdict.depth - b.verdict.depth);
      const subsumed = new Set();
      for (let index = 0; index < evaluated.length; index++) {
        if (context.stopped) break;
        if (index && index % SD_BATCH_SIZE === 0 && !await this._waitForEditorQuiet()) {
          report.truncated = true;
          report.skipReason = 'quiet-gate-abort';
          break;
        }
        let verdict = evaluated[index].verdict;
        const line = evaluated[index].line;
        if (subsumed.has(verdict.lineGuid)) verdict = this._replaceVerdict(verdict, { status: 'skip', reason: 'subsumed' });
        else if (verdict.status === 'delete' || verdict.status === 'defuse') {
          try {
            const verified = await this._reverify(line, discovery);
            verdict = verified;
            if (verdict.status === 'delete' || verdict.status === 'defuse') {
              const planned = verdict.status === 'delete' ? verdict.subtreeSize : 1;
              const remaining = this._settings.lineWriteBudget - context.actionWrites;
              const oversizedFirst = context.attemptedSubtrees === 0;
              if (planned > remaining && !oversizedFirst) {
                report.capped = true;
                verdict = this._replaceVerdict(verdict, { status: 'skip', reason: 'budget', deferred: true });
              } else if (options.dryRun) {
                context.attemptedSubtrees++;
                context.actionWrites += planned;
                const action = Object.freeze({ kind: verdict.status, ok: true, writes: 0, deletedLines: verdict.status === 'delete' ? planned : undefined });
                verdict = this._replaceVerdict(verdict, { action });
              } else if (verdict.status === 'delete') {
                context.attemptedSubtrees++;
                const result = await this._destroyLine(line, discovery, context);
                verdict = this._replaceVerdict(result.verdict || verdict, { action: Object.freeze(result.action) });
                if (result.completed) for (const guid of result.deletedGuids) subsumed.add(guid);
              } else {
                context.attemptedSubtrees++;
                const result = await this._defuse(line, discovery, context);
                verdict = this._replaceVerdict(result.verdict || verdict, { action: Object.freeze(result.action) });
              }
            }
          } catch (error) {
            const record = this._lineRecord(line);
            this._reportError(report, 'action', error, line && line.guid, record && record.guid);
            verdict = this._replaceVerdict(verdict, { status: 'skip', reason: 'error' });
          }
        }
        report.verdicts.push(verdict);
        this._countVerdict(report, verdict);
      }
      if (!options.dryRun && this._settings.logEnabled && !report.skipped && (report.writes > 0 || report.errors.length > 0 || report.circuitBroken)) {
        try { await this._appendLog(report, context); }
        catch (error) { this._reportError(report, 'log', error, null, null); }
      }
    } catch (error) {
      this._reportError(report, 'sweep', error, null, null);
    }
    return this._finishReport(report, context);
  }

  _finishReport(report, context) {
    report.writeAttempts = context.writeAttempts;
    report.writes = report.writes || 0;
    report.consecutiveDeleteFailures = context.consecutiveDeleteFailures;
    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - report.startedAt;
    try {
      const stats = window.__SD_STATS;
      for (const error of report.errors) Object.freeze(error);
      Object.freeze(report.errors);
      Object.freeze(report.verdicts);
      Object.freeze(report.counts);
      Object.freeze(report);
      stats.reports.push(report);
      while (stats.reports.length > SD_STATS_LIMIT) stats.reports.shift();
      stats.totals.sweeps++;
      if (report.skipped) stats.totals.skipped++;
      stats.totals.writes += report.writes;
      stats.totals.failures += report.failures;
      stats.totals.deletedLines += report.deletedLines;
      stats.totals.defused += report.counts.defuse;
    } catch (_) {}
    return report;
  }

  _countVerdict(report, verdict) {
    if (verdict.status === 'malformed') report.counts.malformed++;
    else if (verdict.status === 'no-ts') report.counts.noTs++;
    else if (verdict.status === 'wait') report.counts.wait++;
    else if (verdict.status === 'keep') report.counts.keep++;
    else if (verdict.status === 'delete') {
      if (report.dryRun) report.counts.wouldDelete++;
      else if (verdict.action && verdict.action.ok) report.counts.delete++;
      else if (verdict.action && verdict.action.partial) {
        report.counts.delete++;
        report.failures++;
      }
      else report.counts.skip++;
    } else if (verdict.status === 'defuse') {
      if (report.dryRun) report.counts.wouldDefuse++;
      else if (verdict.action && verdict.action.ok) report.counts.defuse++;
      else report.counts.skip++;
    } else report.counts.skip++;
  }

  _replaceVerdict(verdict, changes) {
    const next = Object.assign({}, verdict, changes || {}, {
      tags: Object.freeze((verdict.tags || []).slice()),
      malformedTags: Object.freeze((verdict.malformedTags || []).slice()),
      descendants: Object.freeze((verdict.descendants || []).slice()),
    });
    if (next.action) {
      const action = Object.assign({}, next.action);
      if (action.content) action.content = Object.freeze(action.content.slice());
      next.action = Object.freeze(action);
    }
    return frozenVerdict(next);
  }

  _lineRecord(line) {
    try { return line && typeof line.getRecord === 'function' ? line.getRecord() : line && line.record || null; } catch (_) { return line && line.record || null; }
  }

  _collectionGuid(record) {
    return record && (record.collection_guid || record.collectionGuid || record.parent_guid || record.parentGuid) || null;
  }

  _isTrashed(record) {
    if (!record) return false;
    // PluginRecord exposes no trashed flag in types.d.ts 4789; live verification must confirm whether searchByQuery returns lines from trashed records at all — until then this is best-effort.
    try { return typeof record.isTrashed === 'function' ? !!record.isTrashed() : false; } catch (_) { return true; }
  }

  _baseSkip(line, reason) {
    const record = this._lineRecord(line);
    return frozenVerdict({
      lineGuid: line && line.guid || '',
      recordGuid: record && record.guid || null,
      recordName: this._recordName(record),
      collectionGuid: this._collectionGuid(record),
      text: lineText(line),
      status: 'skip',
      reason,
    });
  }

  _recordName(record) {
    try { return record && record.getName ? String(record.getName() || '') : ''; } catch (_) { return ''; }
  }

  async _discover(report, context) {
    // Hashtag search is EXACT-match per full tag ('#sd' does not find '#sd/now' —
    // verified live 2026-07-31), so union the exact-tag query with a quoted literal
    // text query; the strict segment re-filter below drops the literal query's
    // false positives ('#sdk', prose mentions).
    const exact = await this.data.searchByQuery('#sd', SD_SEARCH_LIMIT);
    const literal = await this.data.searchByQuery('"#sd"', SD_SEARCH_LIMIT);
    const failed = [exact, literal].find(result => !result || result.error);
    if (failed !== undefined) {
      report.skipped = true;
      report.skipReason = 'search-error';
      this._reportError(report, 'search', new Error('searchByQuery: ' + String(failed && failed.error || 'no result')), null, null);
      return { lines: [], searchCapped: false, templateRecords: new Set(), logGuid: null };
    }
    const dedup = new Map();
    for (const line of (exact.lines || []).concat(literal.lines || [])) {
      if (!line || !line.guid) continue;
      const strict = (line.segments || []).some(segment => segment && segment.type === 'hashtag' && typeof segment.text === 'string' && SD_TAG_RE.test(segment.text));
      if (strict && !dedup.has(line.guid)) dedup.set(line.guid, line);
    }
    const templateRecords = new Set();
    const collections = await this.data.getAllCollections();
    const templates = (collections || []).find(collection => {
      try { return collection.getGuid() === SD_TEMPLATES_COLLECTION_GUID; } catch (_) { return false; }
    });
    if (templates) {
      for (const record of await templates.getAllRecords()) if (record && record.guid) templateRecords.add(record.guid);
    }
    this._adoptTemplateGuids(templateRecords);
    const logRecord = await this._findLogRecord(false, context);
    return {
      lines: Array.from(dedup.values()),
      searchCapped: (exact.lines || []).length >= SD_SEARCH_LIMIT || (literal.lines || []).length >= SD_SEARCH_LIMIT,
      templateRecords,
      logGuid: logRecord && logRecord.guid || null,
    };
  }

  _sdTags(line) {
    return (line && line.segments || [])
      .filter(segment => segment && segment.type === 'hashtag' && typeof segment.text === 'string' && SD_TAG_RE.test(segment.text))
      .map(segment => segment.text);
  }

  _hasKeep(line) {
    return hasKeepTag(line && line.segments || []);
  }

  _ageBasis(line, record, now) {
    const candidates = [];
    try { candidates.push(['line-created', line.getCreatedAt()]); } catch (_) {}
    try { candidates.push(['line-updated', line.getUpdatedAt()]); } catch (_) {}
    try { const details = record && record.getJournalDetails && record.getJournalDetails(); candidates.push(['journal-date', details && details.date]); } catch (_) {}
    try { candidates.push(['record-created', record && record.getCreatedAt && record.getCreatedAt()]); } catch (_) {}
    for (const [basis, value] of candidates) {
      const at = value instanceof Date ? value.getTime() : Number.NaN;
      if (!Number.isFinite(at)) continue;
      if (at - now > 365 * 86400000) return { basis: null, at: null, reason: 'future-created' };
      return { basis, at, reason: null };
    }
    return { basis: null, at: null, reason: 'no-ts' };
  }

  async _evaluateLine(line, discovery, now, options) {
    const record = this._lineRecord(line);
    const base = {
      lineGuid: line && line.guid || '',
      recordGuid: record && record.guid || null,
      recordName: this._recordName(record),
      collectionGuid: this._collectionGuid(record),
      text: lineText(line),
    };
    if (!record) return frozenVerdict(Object.assign(base, { status: 'skip', reason: 'no-record' }));
    if (this._isTrashed(record)) return frozenVerdict(Object.assign(base, { status: 'skip', reason: 'trashed-record' }));
    if (discovery.templateRecords.has(record.guid)) return frozenVerdict(Object.assign(base, { status: 'skip', reason: 'template' }));
    if ((discovery.logGuid && record.guid === discovery.logGuid) || this._recordName(record) === SD_LOG_NAME) {
      return frozenVerdict(Object.assign(base, { status: 'skip', reason: 'log-record' }));
    }

    const rawTags = this._sdTags(line);
    if (!rawTags.length) return frozenVerdict(Object.assign(base, { status: 'skip', reason: 'tag-removed' }));
    const merged = mergeSdTags(rawTags, parseDuration(this._settings.defaultDelay));
    const common = Object.assign(base, {
      tags: Object.freeze(rawTags.slice()),
      malformedTags: Object.freeze(merged.malformedTags.map(tag => tag.raw)),
    });
    if (!merged.valid) return frozenVerdict(Object.assign(common, { status: 'malformed', reason: 'malformed-tag' }));

    const age = this._ageBasis(line, record, now);
    if (age.at === null) return frozenVerdict(Object.assign(common, { status: 'no-ts', reason: age.reason }));
    const deadline = computeDeadline(age.at, merged.delayMs);
    if (deadline === null) return frozenVerdict(Object.assign(common, { status: 'no-ts', reason: 'deadline-overflow', basis: age.basis, basisAt: age.at }));

    const tree = await line.getTreeContext();
    const ancestors = tree && tree.ancestors || [];
    const descendants = tree && tree.descendants || [];
    const treeFields = {
      basis: age.basis,
      basisAt: age.at,
      deadline,
      remainingMs: deadline - now,
      subtreeSize: 1 + descendants.length,
      depth: ancestors.length,
      descendants: Object.freeze(descendants.map(item => item.guid)),
    };
    if ([line].concat(ancestors, descendants).some(item => this._hasKeep(item))) {
      return frozenVerdict(Object.assign(common, treeFields, { status: 'keep', reason: 'keep-veto' }));
    }
    if (now < deadline) return frozenVerdict(Object.assign(common, treeFields, { status: 'wait', reason: 'not-expired' }));
    if (!(options && options.ignoreCaret)) {
      const caretGuid = this._currentCaretGuid();
      if (caretGuid && [line].concat(descendants).some(item => item.guid === caretGuid)) {
        return frozenVerdict(Object.assign(common, treeFields, { status: 'skip', reason: 'caret' }));
      }
    }
    if ([line].concat(descendants).some(item => this._resurrected.has(item.guid))) {
      return frozenVerdict(Object.assign(common, treeFields, { status: 'defuse', reason: 'resurrected', empty: null }));
    }
    if (merged.empty) {
      const empty = isEmptyDestructTarget(line, descendants);
      return frozenVerdict(Object.assign(common, treeFields, { status: empty ? 'delete' : 'defuse', reason: empty ? 'empty' : 'content', empty }));
    }
    return frozenVerdict(Object.assign(common, treeFields, { status: 'delete', reason: 'expired', empty: null }));
  }

  async _freshRoot(originalLine) {
    const record = this._lineRecord(originalLine);
    if (!record || this._isTrashed(record)) return null;
    const lines = await record.getLineItems(false);
    return (lines || []).find(line => line.guid === originalLine.guid) || null;
  }

  async _reverify(originalLine, discovery, options) {
    return (await this._reverifyState(originalLine, discovery, options)).verdict;
  }

  async _reverifyState(originalLine, discovery, options) {
    const fresh = await this._freshRoot(originalLine);
    if (!fresh) return { fresh: null, verdict: this._baseSkip(originalLine, 'missing') };
    return { fresh, verdict: await this._evaluateLine(fresh, discovery, Date.now(), options) };
  }

  _tripCircuit(context, reason) {
    context.stopped = true;
    context.report.circuitBroken = true;
    context.report.circuitReason = reason;
  }

  _canWrite(context) {
    if (context.stopped) return false;
    if (context.writeAttempts >= SD_HARD_WRITE_CAP) {
      this._tripCircuit(context, '300-write cap');
      return false;
    }
    return true;
  }

  async _attemptWrite(context, phase, fn, lineGuid, recordGuid, isDelete, isAction) {
    if (!this._canWrite(context)) return false;
    context.writeAttempts++;
    try {
      const ok = await fn();
      if (!ok) throw new Error(phase + ' returned false');
      context.report.writes++;
      if (isAction) context.actionWrites++;
      if (isDelete) context.consecutiveDeleteFailures = 0;
      if (context.writeAttempts >= SD_HARD_WRITE_CAP) this._tripCircuit(context, '300-write cap');
      return true;
    } catch (error) {
      context.report.failures++;
      this._reportError(context.report, phase, error, lineGuid, recordGuid);
      if (isDelete) {
        context.consecutiveDeleteFailures++;
        if (context.consecutiveDeleteFailures >= SD_FAILURE_CAP) this._tripCircuit(context, '10 consecutive delete failures');
      }
      if (context.writeAttempts >= SD_HARD_WRITE_CAP) this._tripCircuit(context, '300-write cap');
      return false;
    }
  }

  async _manualDeleteVerdict(state, discovery, options) {
    const verdict = state && state.verdict;
    if (options && options.bypassExpiry && state.fresh && verdict && verdict.status === 'wait' && Number.isFinite(verdict.deadline)) {
      return await this._evaluateLine(state.fresh, discovery, Math.max(Date.now(), verdict.deadline), options);
    }
    return verdict;
  }

  async _destroyLine(originalLine, discovery, context, options) {
    let state = await this._reverifyState(originalLine, discovery, options);
    let verdict = await this._manualDeleteVerdict(state, discovery, options);
    const deleteVerdict = verdict;
    const deletedGuids = [];
    const content = [];
    if (verdict.status !== 'delete') return { completed: false, deletedGuids, verdict, action: { kind: 'delete', ok: false, writes: 0, deletedLines: 0, content } };
    const recordGuid = verdict.recordGuid;
    const targets = verdict.descendants.slice().reverse().concat(verdict.lineGuid);
    let lastQuietCheckAt = 0;
    for (const targetGuid of targets) {
      if (context.stopped) break;
      if (deletedGuids.length > 0 && deletedGuids.length % SD_BATCH_SIZE === 0 && deletedGuids.length !== lastQuietCheckAt) {
        lastQuietCheckAt = deletedGuids.length;
        if (!await this._waitForEditorQuiet()) break;
      }
      state = await this._reverifyState(originalLine, discovery, options);
      verdict = await this._manualDeleteVerdict(state, discovery, options);
      if (verdict.status === 'defuse' && verdict.reason === 'content' &&
          deleteVerdict.empty === true && verdict.subtreeSize === 1 && deletedGuids.length > 0) {
        // Our own deletions turned the tagged line into a leaf, so the leaf rule
        // now reads its own text as content — but the original subtree-mode
        // verdict already ruled that text out. Finish the planned delete. A REAL
        // mid-sweep change (a new child) leaves subtreeSize > 1 and still aborts.
        verdict = this._replaceVerdict(verdict, { status: 'delete', reason: 'empty-continue', empty: true });
      }
      if (verdict.status !== 'delete') break;
      const freshRoot = state.fresh;
      if (!freshRoot) break;
      const tree = await freshRoot.getTreeContext();
      const current = [freshRoot].concat(tree.descendants || []).find(item => item.guid === targetGuid);
      if (!current) continue;
      const owner = typeof current.getRecord === 'function' ? current.getRecord() : current.record;
      if (!owner || owner.guid !== recordGuid) continue;
      const snapshot = lineText(current).slice(0, SD_LOG_TEXT_LIMIT);
      const ok = await this._attemptWrite(context, 'delete', () => current.delete(), current.guid, recordGuid, true, true);
      if (!ok) break;
      content.push(snapshot);
      deletedGuids.push(current.guid);
      context.report.deletedLines++;
    }
    const completed = deletedGuids.includes(originalLine.guid);
    const partial = !completed && deletedGuids.length > 0;
    return {
      completed,
      deletedGuids,
      verdict: partial ? deleteVerdict : verdict,
      action: { kind: 'delete', ok: completed, partial, writes: deletedGuids.length, deletedLines: deletedGuids.length, content },
    };
  }

  async _defuse(originalLine, discovery, context, options) {
    const state = await this._reverifyState(originalLine, discovery, options);
    let verdict = state.verdict;
    const manuallyDefusable = options && options.manual && state.fresh && this._sdTags(state.fresh).length && (
      ['malformed','no-ts','wait','keep','delete','defuse'].includes(verdict.status)
    );
    if (manuallyDefusable && verdict.status !== 'defuse') verdict = this._replaceVerdict(verdict, { status: 'defuse', reason: 'manual-defuse' });
    if (verdict.status !== 'defuse') return { verdict, action: { kind: 'defuse', ok: false, writes: 0, content: [] } };
    const fresh = state.fresh;
    if (!fresh) return { verdict: this._baseSkip(originalLine, 'missing'), action: { kind: 'defuse', ok: false, writes: 0, content: [] } };
    const before = lineText(fresh).slice(0, SD_LOG_TEXT_LIMIT);
    const ok = await this._attemptWrite(context, 'defuse', () => fresh.setSegments(defusedSegments(fresh.segments || [])), fresh.guid, verdict.recordGuid, false, true);
    return { verdict, action: { kind: 'defuse', ok, writes: ok ? 1 : 0, content: [before] } };
  }

  async _findLogRecord(create, context) {
    const sweepCache = context && context.logCache;
    const remember = record => {
      if (sweepCache) {
        sweepCache.resolved = true;
        sweepCache.record = record || null;
      }
      return record || null;
    };
    if (sweepCache && sweepCache.record) return sweepCache.record;
    if (!sweepCache || !sweepCache.resolved) {
      let cachedGuid = null;
      try { cachedGuid = localStorage.getItem(SD_LOG_GUID_KEY); } catch (_) {}
      if (cachedGuid) {
        const cached = this.data.getRecord(cachedGuid);
        if (cached && !this._isTrashed(cached) && this._recordName(cached) === SD_LOG_NAME) return remember(cached);
      }
      for (const record of this.data.getAllRecords() || []) {
        if (record && !this._isTrashed(record) && this._recordName(record) === SD_LOG_NAME) {
          try { localStorage.setItem(SD_LOG_GUID_KEY, record.guid); } catch (_) {}
          return remember(record);
        }
      }
      remember(null);
    }
    if (!create) return null;
    const collections = await this.data.getAllCollections();
    const collection = (collections || []).find(item => {
      try { return item.getGuid() === this._settings.logCollection; } catch (_) { return false; }
    });
    if (!collection) throw new Error('Log collection not found: ' + this._settings.logCollection);
    const guid = collection.createRecord(SD_LOG_NAME);
    if (!guid) throw new Error('Could not create Self-Destruct Log');
    for (let attempt = 0; attempt < 24; attempt++) {
      const record = this.data.getRecord(guid);
      if (record) {
        try { localStorage.setItem(SD_LOG_GUID_KEY, guid); } catch (_) {}
        return remember(record);
      }
      await sleep(100);
    }
    throw new Error('Self-Destruct Log did not replicate within 2.4s');
  }

  _logTimestamp(date) {
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  _summaryTimestamp(line) {
    const match = lineText(line).match(SD_SUMMARY_RE);
    if (!match) return null;
    const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  async _hasRecentLogSummary(context) {
    const log = await this._findLogRecord(false, context);
    if (!log) return false;
    const lines = await log.getLineItems(false);
    const isTop = line => !line.parent_guid || line.parent_guid === log.guid;
    let latest = null;
    for (const line of lines || []) {
      if (!isTop(line)) continue;
      const at = this._summaryTimestamp(line);
      if (at !== null) latest = latest === null ? at : Math.max(latest, at);
    }
    return latest !== null && Date.now() - latest < SD_MULTI_CLIENT_MS;
  }

  async _createLogLine(record, parent, after, segments, context) {
    let created = null;
    const ok = await this._attemptWrite(context, 'log-write', async () => {
      created = await record.createLineItem(parent || null, after || null, 'ulist', segments, null);
      return !!created;
    }, parent && parent.guid || null, record.guid, false, false);
    return ok ? created : null;
  }

  _logDetailSegments(prefix, verdict) {
    const segments = [{ type: 'text', text: prefix + ' ' }];
    if (verdict.recordGuid) segments.push({ type: 'ref', text: { guid: verdict.recordGuid } });
    const suffix = (verdict.text || '').slice(0, SD_LOG_TEXT_LIMIT);
    if (suffix) segments.push({ type: 'text', text: ' — ' + suffix });
    return segments;
  }

  async _appendLog(report, context) {
    const logContext = {
      report,
      writeAttempts: 0,
      actionWrites: 0,
      attemptedSubtrees: 0,
      consecutiveDeleteFailures: 0,
      stopped: false,
      logCache: context.logCache || { resolved: false, record: null },
    };
    try {
      const log = await this._findLogRecord(true, logContext);
      const lines = await log.getLineItems(false);
      const isTop = line => !line.parent_guid || line.parent_guid === log.guid;
      const top = (lines || []).filter(isTop);
      const after = top.length ? top[top.length - 1] : null;
      const warn = report.capped || report.searchCapped || report.circuitBroken ? ' ⚠' : '';
      const capped = report.capped ? ' capped' : '';
      const summaryText = this._logTimestamp(new Date()) + ' — ' + report.counts.delete + ' deleted (' + report.deletedLines + ' lines), ' + report.counts.defuse + ' defused, ' + report.counts.keep + ' kept' + warn + capped;
      const summary = await this._createLogLine(log, null, after, [{ type: 'text', text: summaryText }], logContext);
      if (!summary) return;
      let detailAfter = null;
      let contentCount = 0;
      if (report.circuitBroken) {
        detailAfter = await this._createLogLine(log, summary, null, [{ type: 'text', text: '[err] breaker ' + String(report.circuitReason || 'unknown') }], logContext);
      }
      for (const verdict of report.verdicts) {
        let prefix = null;
        if (verdict.status === 'delete' && verdict.action && verdict.action.ok) prefix = '[del]';
        else if (verdict.status === 'delete' && verdict.action && verdict.action.deletedLines > 0) prefix = '[del*]';
        else if (verdict.status === 'defuse' && verdict.action && verdict.action.ok) prefix = '[fuse]';
        if (!prefix) continue;
        const detail = await this._createLogLine(log, summary, detailAfter, this._logDetailSegments(prefix, verdict), logContext);
        if (!detail) break;
        detailAfter = detail;
        if (this._settings.contentLog && (prefix === '[del]' || prefix === '[del*]')) {
          let contentAfter = null;
          for (const text of verdict.action.content || []) {
            if (contentCount >= SD_LOG_CONTENT_LIMIT) break;
            const child = await this._createLogLine(log, detail, contentAfter, [{ type: 'text', text: String(text || '').slice(0, SD_LOG_TEXT_LIMIT) }], logContext);
            if (!child) break;
            contentAfter = child;
            contentCount++;
          }
        }
      }
      for (const error of report.errors.slice(0, 20)) {
        const segments = [{ type: 'text', text: '[err] ' + error.phase + ' ' }];
        if (error.recordGuid) segments.push({ type: 'ref', text: { guid: error.recordGuid } });
        segments.push({ type: 'text', text: ' — ' + error.message.slice(0, SD_LOG_TEXT_LIMIT) });
        const detail = await this._createLogLine(log, summary, detailAfter, segments, logContext);
        if (!detail) break;
        detailAfter = detail;
      }
      await this._pruneLog(log, logContext);
    } finally {
      context.writeAttempts += logContext.writeAttempts;
    }
  }

  async _pruneLog(log, context) {
    const lines = await log.getLineItems(false);
    const isTop = line => !line.parent_guid || line.parent_guid === log.guid;
    const summaries = (lines || []).filter(line => isTop(line) && SD_SUMMARY_RE.test(lineText(line)));
    if (summaries.length <= SD_LOG_SWEEP_LIMIT) return;
    const remove = summaries.slice(0, summaries.length - SD_LOG_SWEEP_LIMIT);
    for (const old of remove) {
      if (context.stopped) break;
      const freshLines = await log.getLineItems(false);
      const fresh = (freshLines || []).find(line => line.guid === old.guid);
      if (!fresh) continue;
      const tree = await fresh.getTreeContext();
      const currentByGuid = new Map((freshLines || []).map(line => [line.guid, line]));
      for (const target of (tree.descendants || []).slice().reverse().concat(fresh)) {
        if (context.stopped) break;
        const current = currentByGuid.get(target.guid);
        if (!current) continue;
        const ok = await this._attemptWrite(context, 'log-prune', () => current.delete(), current.guid, log.guid, true, false);
        if (!ok) break;
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Object.freeze({
    parseSdTag,
    mergeSdTags,
    computeDeadline,
    classifyLine,
    isSubtreeEmpty,
    hasKeepTag,
    isEmptyDestructTarget,
    defusedSegments,
    formatCountdown,
    parseDuration,
    parseAttrLine,
    lineText,
    matchesSdTagText,
    Plugin,
  });
}
