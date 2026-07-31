'use strict';

const SD_VERSION = '0.1.0';
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
const SD_TAG_RE = /^#sd(?:\/|$)/i;
const SD_KEEP_RE = /^#keep$/i;
const SD_SUMMARY_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — /;
const SD_DEFAULTS = Object.freeze({
  defaultDelay: '3d',
  lineWriteBudget: 100,
  dryRun: true,
  logEnabled: true,
  contentLog: true,
  logCollection: SD_SCRATCHPAD_COLLECTION_GUID,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  if (!active.length) {
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
  if (['image', 'file', 'transclusion'].includes(type)) {
    return Object.freeze({ empty: false, reason: type });
  }
  const segments = line.segments || [];
  const semantic = new Set(['ref', 'datetime', 'linkobj', 'mention', 'image', 'file', 'transclusion']);
  for (const segment of segments) {
    if (semantic.has(String(segment && segment.type || '').toLowerCase())) {
      return Object.freeze({ empty: false, reason: 'segment:' + segment.type });
    }
  }
  const text = segments
    .filter(segment => segment && segment.type !== 'hashtag')
    .map(segment => typeof segment.text === 'string' ? segment.text : segment.text && segment.text.title || '')
    .join('')
    .trim();
  if (!text) return Object.freeze({ empty: true, reason: 'blank-or-hashtag' });
  const attr = parseAttrLine(text);
  if (attr && !(attr[2] || '').trim()) return Object.freeze({ empty: true, reason: 'bare-attribute' });
  return Object.freeze({ empty: false, reason: attr ? 'filled-attribute' : 'text' });
}

function isSubtreeEmpty(descendants) {
  return (descendants || []).every(line => classifyLine(line).empty);
}

function defusedSegments(segments) {
  const output = [];
  let removed = false;
  for (const source of segments || []) {
    if (source && source.type === 'hashtag' && typeof source.text === 'string' && SD_TAG_RE.test(source.text)) {
      removed = true;
      continue;
    }
    const segment = Object.assign({}, source || {});
    if (segment.text && typeof segment.text === 'object') segment.text = Object.assign({}, segment.text);
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
 *   deferred: boolean, action: null|{kind:string, ok:boolean, writes:number, deletedLines?:number, content?:string[]}
 * }
 *
 * SweepReportShape = {
 *   schemaVersion: 1, sweepId: string, source: 'scheduled'|'manual'|'dry-run',
 *   dryRun: boolean, startedAt: number, finishedAt: number|null, durationMs: number|null,
 *   skipped: boolean, skipReason: string|null, searchCapped: boolean, capped: boolean,
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
    window.__SD_VERSION = SD_VERSION;
    try { if (typeof window.__sdDispose === 'function') window.__sdDispose(); } catch (_) {}
    try { if (window.__sdInterval) clearInterval(window.__sdInterval); } catch (_) {}
    try { if (window.__sdFirstPass) clearTimeout(window.__sdFirstPass); } catch (_) {}
    try { if (window.__sdActivityHandler) ['keydown','beforeinput','input','pointerdown','compositionstart','wheel','touchstart','visibilitychange'].forEach(name => document.removeEventListener(name, window.__sdActivityHandler, true)); } catch (_) {}
    try { (window.__sdEventIds || []).forEach(id => this.events.off(id)); } catch (_) {}
    try { (window.__sdCommands || []).forEach(command => command && command.remove && command.remove()); } catch (_) {}
    for (const key of ['__sdDispose','__sdInterval','__sdFirstPass','__sdActivityHandler','__sdEventIds','__sdCommands','__sdInstance']) { try { delete window[key]; } catch (_) {} }

    console.log('%c[Self Destruct] v' + SD_VERSION + ' loaded — dry-run first, subtree-safe.', 'color:#ef4444;font-weight:700;font-size:12px');
    this.VERSION = SD_VERSION;
    this._disposed = false;
    this._running = false;
    this._pendingRerun = null;
    this._sweepPromise = null;
    this._eventIds = [];
    this._commands = [];
    this._quietWaiters = new Set();
    this._resurrected = new Set();
    this._settings = this._loadSettings();
    this._lastActivityAt = Date.now();
    this._activityHandler = () => { if (!this._disposed) this._lastActivityAt = Date.now(); };
    this._activityEvents = ['keydown','beforeinput','input','pointerdown','compositionstart','wheel','touchstart','visibilitychange'];
    try {
      for (const name of this._activityEvents) document.addEventListener(name, this._activityHandler, true);
      window.__sdActivityHandler = this._activityHandler;
    } catch (_) {}

    this._initForensics();
    this._subscribeUndeletes();
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
    window.__sdInstance = this;
    window.__sdDispose = () => this._dispose();
  }

  onUnload() { this._dispose(); }

  _dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { if (window.__sdInterval) clearInterval(window.__sdInterval); } catch (_) {}
    try { if (window.__sdFirstPass) clearTimeout(window.__sdFirstPass); } catch (_) {}
    try { for (const name of this._activityEvents || []) document.removeEventListener(name, this._activityHandler, true); } catch (_) {}
    try { for (const id of this._eventIds || []) this.events.off(id); } catch (_) {}
    try { for (const command of this._commands || []) command && command.remove && command.remove(); } catch (_) {}
    for (const waiter of this._quietWaiters || []) {
      try { clearTimeout(waiter.timer); waiter.resolve(false); } catch (_) {}
    }
    this._quietWaiters && this._quietWaiters.clear();
    try { if (window.__SD_SWEEP === this._sweepGlobal) delete window.__SD_SWEEP; } catch (_) {}
    try { if (window.__SD_DRY === this._dryGlobal) delete window.__SD_DRY; } catch (_) {}
    if (typeof window !== 'undefined' && window.__sdInstance === this) {
      for (const key of ['__sdDispose','__sdInterval','__sdFirstPass','__sdActivityHandler','__sdEventIds','__sdCommands','__sdInstance']) { try { delete window[key]; } catch (_) {} }
    }
  }

  _loadSettings() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SD_SETTINGS_KEY) || '{}') || {}; } catch (_) {}
    const merged = Object.assign({}, SD_DEFAULTS, stored);
    if (parseDuration(merged.defaultDelay) === null) merged.defaultDelay = SD_DEFAULTS.defaultDelay;
    merged.lineWriteBudget = Math.max(1, Math.min(SD_HARD_WRITE_CAP, Math.floor(Number(merged.lineWriteBudget) || SD_DEFAULTS.lineWriteBudget)));
    merged.dryRun = stored.dryRun === undefined ? true : stored.dryRun === true;
    merged.logEnabled = stored.logEnabled === undefined ? true : stored.logEnabled === true;
    merged.contentLog = stored.contentLog === undefined ? true : stored.contentLog === true;
    merged.logCollection = String(merged.logCollection || SD_SCRATCHPAD_COLLECTION_GUID);
    return merged;
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
        if (event && event.lineItemGuid) this._resurrected.add(event.lineItemGuid);
      }, { collection: '*' });
      if (id) this._eventIds.push(id);
    } catch (error) { this._recordStandaloneError('subscribe', error, null, null); }
  }

  _registerCommands() {
    try {
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
    } catch (error) { this._recordStandaloneError('commands', error, null, null); }
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
    let overlayWasOpen = false;
    while (!this._disposed) {
      if (this._nativeOverlayVisible() || this._inputPending()) {
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

  _requestSweep(options) {
    if (this._disposed) return Promise.resolve(null);
    if (this._running) {
      this._pendingRerun = Object.assign({}, options, { manual: true });
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
    const context = { report, writeAttempts: 0, actionWrites: 0, consecutiveDeleteFailures: 0, stopped: false };
    try {
      let workspaceGuid = null;
      try { workspaceGuid = this.getWorkspaceGuid(); } catch (_) {}
      if (workspaceGuid !== SD_WORKSPACE_GUID) {
        report.skipped = true; report.skipReason = 'wrong-workspace'; return this._finishReport(report, context);
      }
      if (!await this._waitForEditorQuiet()) {
        report.skipped = true; report.skipReason = 'disposed'; return this._finishReport(report, context);
      }
      if (!options.manual && await this._hasRecentLogSummary()) {
        report.skipped = true; report.skipReason = 'multi-client'; return this._finishReport(report, context);
      }

      const discovery = await this._discover(report);
      report.searchCapped = discovery.searchCapped;
      report.candidates = discovery.lines.length;
      const evaluated = [];
      for (let index = 0; index < discovery.lines.length; index++) {
        if (index && index % SD_BATCH_SIZE === 0 && !await this._waitForEditorQuiet()) break;
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
        if (index && index % SD_BATCH_SIZE === 0 && !await this._waitForEditorQuiet()) break;
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
              const oversizedFirst = context.actionWrites === 0;
              if (planned > remaining && !oversizedFirst) {
                report.capped = true;
                verdict = this._replaceVerdict(verdict, { status: 'skip', reason: 'budget', deferred: true });
              } else if (options.dryRun) {
                const action = Object.freeze({ kind: verdict.status, ok: true, writes: 0, deletedLines: verdict.status === 'delete' ? planned : undefined });
                verdict = this._replaceVerdict(verdict, { action });
              } else if (verdict.status === 'delete') {
                const result = await this._destroyLine(line, discovery, context);
                verdict = this._replaceVerdict(result.verdict || verdict, { action: Object.freeze(result.action) });
                if (result.completed) for (const guid of result.deletedGuids) subsumed.add(guid);
              } else {
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
      if (!options.dryRun && this._settings.logEnabled) {
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
    if (record.trashed === true || record._trashed === true || record.props && record.props.trashed === true) return true;
    try { return !!(typeof record.isTrashed === 'function' && record.isTrashed()); } catch (_) { return true; }
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

  async _discover(report) {
    const result = await this.data.searchByQuery('#sd', SD_SEARCH_LIMIT);
    if (!result || result.error) throw new Error('searchByQuery: ' + String(result && result.error || 'no result'));
    const dedup = new Map();
    for (const line of result.lines || []) {
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
    const logRecord = await this._findLogRecord(false);
    return {
      lines: Array.from(dedup.values()),
      searchCapped: (result.lines || []).length + (result.records || []).length >= SD_SEARCH_LIMIT,
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
    return (line && line.segments || []).some(segment => segment && segment.type === 'hashtag' && typeof segment.text === 'string' && SD_KEEP_RE.test(segment.text));
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
      if (basis === 'line-created' && at - now > 365 * 86400000) return { basis: null, at: null, reason: 'future-created' };
      return { basis, at, reason: null };
    }
    return { basis: null, at: null, reason: 'no-ts' };
  }

  async _evaluateLine(line, discovery, now) {
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
    if (now < deadline) return frozenVerdict(Object.assign(common, treeFields, { status: 'wait', reason: 'not-expired' }));
    if ([line].concat(ancestors, descendants).some(item => this._hasKeep(item))) {
      return frozenVerdict(Object.assign(common, treeFields, { status: 'keep', reason: 'keep-veto' }));
    }
    const caretGuid = this._currentCaretGuid();
    if (caretGuid && [line].concat(descendants).some(item => item.guid === caretGuid)) {
      return frozenVerdict(Object.assign(common, treeFields, { status: 'skip', reason: 'caret' }));
    }
    if ([line].concat(descendants).some(item => this._resurrected.has(item.guid))) {
      return frozenVerdict(Object.assign(common, treeFields, { status: 'defuse', reason: 'resurrected', empty: null }));
    }
    if (merged.empty) {
      const empty = isSubtreeEmpty(descendants);
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

  async _reverify(originalLine, discovery) {
    return (await this._reverifyState(originalLine, discovery)).verdict;
  }

  async _reverifyState(originalLine, discovery) {
    const fresh = await this._freshRoot(originalLine);
    if (!fresh) return { fresh: null, verdict: this._baseSkip(originalLine, 'missing') };
    return { fresh, verdict: await this._evaluateLine(fresh, discovery, Date.now()) };
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

  async _destroyLine(originalLine, discovery, context) {
    let verdict = await this._reverify(originalLine, discovery);
    const deletedGuids = [];
    const content = [];
    if (verdict.status !== 'delete') return { completed: false, deletedGuids, verdict, action: { kind: 'delete', ok: false, writes: 0, deletedLines: 0, content } };
    const recordGuid = verdict.recordGuid;
    const targets = verdict.descendants.slice().reverse().concat(verdict.lineGuid);
    for (const targetGuid of targets) {
      if (context.stopped) break;
      const state = await this._reverifyState(originalLine, discovery);
      verdict = state.verdict;
      if (verdict.status !== 'delete') break;
      const freshRoot = state.fresh;
      if (!freshRoot) break;
      const tree = await freshRoot.getTreeContext();
      const current = [freshRoot].concat(tree.descendants || []).find(item => item.guid === targetGuid);
      if (!current) continue;
      content.push(lineText(current).slice(0, SD_LOG_TEXT_LIMIT));
      const ok = await this._attemptWrite(context, 'delete', () => current.delete(), current.guid, recordGuid, true, true);
      if (!ok) break;
      deletedGuids.push(current.guid);
      context.report.deletedLines++;
    }
    const completed = deletedGuids.includes(originalLine.guid);
    return {
      completed,
      deletedGuids,
      verdict,
      action: { kind: 'delete', ok: completed, writes: deletedGuids.length, deletedLines: deletedGuids.length, content },
    };
  }

  async _defuse(originalLine, discovery, context) {
    const state = await this._reverifyState(originalLine, discovery);
    const verdict = state.verdict;
    if (verdict.status !== 'defuse') return { verdict, action: { kind: 'defuse', ok: false, writes: 0, content: [] } };
    const fresh = state.fresh;
    if (!fresh) return { verdict: this._baseSkip(originalLine, 'missing'), action: { kind: 'defuse', ok: false, writes: 0, content: [] } };
    const before = lineText(fresh).slice(0, SD_LOG_TEXT_LIMIT);
    const ok = await this._attemptWrite(context, 'defuse', () => fresh.setSegments(defusedSegments(fresh.segments || [])), fresh.guid, verdict.recordGuid, false, true);
    return { verdict, action: { kind: 'defuse', ok, writes: ok ? 1 : 0, content: [before] } };
  }

  async _findLogRecord(create) {
    let cachedGuid = null;
    try { cachedGuid = localStorage.getItem(SD_LOG_GUID_KEY); } catch (_) {}
    if (cachedGuid) {
      const cached = this.data.getRecord(cachedGuid);
      if (cached && !this._isTrashed(cached) && this._recordName(cached) === SD_LOG_NAME) return cached;
    }
    for (const record of this.data.getAllRecords() || []) {
      if (record && !this._isTrashed(record) && this._recordName(record) === SD_LOG_NAME) {
        try { localStorage.setItem(SD_LOG_GUID_KEY, record.guid); } catch (_) {}
        return record;
      }
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
        return record;
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
    if (Number.isFinite(parsed)) return parsed;
    try { const created = line.getCreatedAt(); return created instanceof Date ? created.getTime() : null; } catch (_) { return null; }
  }

  async _hasRecentLogSummary() {
    const log = await this._findLogRecord(false);
    if (!log) return false;
    const lines = await log.getLineItems(false);
    let latest = null;
    for (const line of lines || []) {
      if (line.parent_guid) continue;
      const at = this._summaryTimestamp(line);
      if (at !== null) latest = latest === null ? at : Math.max(latest, at);
    }
    return latest !== null && Date.now() - latest >= 0 && Date.now() - latest < SD_MULTI_CLIENT_MS;
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
    if (verdict.recordGuid) segments.push({ type: 'ref', text: verdict.recordGuid });
    const suffix = (verdict.text || '').slice(0, SD_LOG_TEXT_LIMIT);
    if (suffix) segments.push({ type: 'text', text: ' — ' + suffix });
    return segments;
  }

  async _appendLog(report, context) {
    if (context.stopped) return;
    const log = await this._findLogRecord(true);
    const lines = await log.getLineItems(false);
    const top = (lines || []).filter(line => !line.parent_guid);
    const after = top.length ? top[top.length - 1] : null;
    const warn = report.capped || report.searchCapped || report.circuitBroken ? ' ⚠' : '';
    const capped = report.capped ? ' capped' : '';
    const summaryText = this._logTimestamp(new Date()) + ' — ' + report.counts.delete + ' deleted (' + report.deletedLines + ' lines), ' + report.counts.defuse + ' defused, ' + report.counts.keep + ' kept' + warn + capped;
    const summary = await this._createLogLine(log, null, after, [{ type: 'text', text: summaryText }], context);
    if (!summary) return;
    let detailAfter = null;
    let contentCount = 0;
    for (const verdict of report.verdicts) {
      let prefix = null;
      if (verdict.status === 'delete' && verdict.action && verdict.action.ok) prefix = '[del]';
      else if (verdict.status === 'defuse' && verdict.action && verdict.action.ok) prefix = '[fuse]';
      if (!prefix) continue;
      const detail = await this._createLogLine(log, summary, detailAfter, this._logDetailSegments(prefix, verdict), context);
      if (!detail) break;
      detailAfter = detail;
      if (this._settings.contentLog && prefix === '[del]') {
        let contentAfter = null;
        for (const text of verdict.action.content || []) {
          if (contentCount >= SD_LOG_CONTENT_LIMIT) break;
          const child = await this._createLogLine(log, detail, contentAfter, [{ type: 'text', text: String(text || '').slice(0, SD_LOG_TEXT_LIMIT) }], context);
          if (!child) break;
          contentAfter = child;
          contentCount++;
        }
      }
    }
    for (const error of report.errors.slice(0, 20)) {
      const segments = [{ type: 'text', text: '[err] ' + error.phase + ' ' }];
      if (error.recordGuid) segments.push({ type: 'ref', text: error.recordGuid });
      segments.push({ type: 'text', text: ' — ' + error.message.slice(0, SD_LOG_TEXT_LIMIT) });
      const detail = await this._createLogLine(log, summary, detailAfter, segments, context);
      if (!detail) break;
      detailAfter = detail;
    }
    await this._pruneLog(log, context);
  }

  async _pruneLog(log, context) {
    const lines = await log.getLineItems(false);
    const summaries = (lines || []).filter(line => !line.parent_guid && SD_SUMMARY_RE.test(lineText(line)));
    if (summaries.length <= SD_LOG_SWEEP_LIMIT) return;
    const remove = summaries.slice(0, summaries.length - SD_LOG_SWEEP_LIMIT);
    for (const old of remove) {
      if (context.stopped) break;
      const freshLines = await log.getLineItems(false);
      const fresh = (freshLines || []).find(line => line.guid === old.guid);
      if (!fresh) continue;
      const tree = await fresh.getTreeContext();
      for (const target of (tree.descendants || []).slice().reverse().concat(fresh)) {
        if (context.stopped) break;
        const currentLines = await log.getLineItems(false);
        const current = (currentLines || []).find(line => line.guid === target.guid);
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
    defusedSegments,
    formatCountdown,
    parseDuration,
    parseAttrLine,
    lineText,
  });
}
