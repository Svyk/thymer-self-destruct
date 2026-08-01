'use strict';

global.AppPlugin = class AppPlugin {};
global.window = {};

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
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
} = require('../plugin.js');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    error.message = name + ': ' + error.message;
    throw error;
  }
}

function text(value) { return { type: 'text', text: value }; }
function hashtag(value) { return { type: 'hashtag', text: value }; }
function line(segments, type = 'ulist', status = null) {
  return { type, segments, getTaskStatus: () => status };
}

test('runtime and manifest identify the v0.3.2 caret-decoration repair release', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
  assert.strictEqual(manifest.version, '0.3.2');
  assert.ok(source.includes("const SD_VERSION = '0.3.2';"));
});

test('parseDuration accepts minutes', () => assert.strictEqual(parseDuration('30m'), 1800000));
test('parseDuration accepts uppercase weeks', () => assert.strictEqual(parseDuration('2W'), 1209600000));
test('parseDuration accepts zero', () => assert.strictEqual(parseDuration('0h'), 0));
test('parseDuration rejects malformed units', () => assert.strictEqual(parseDuration('3x'), null));
test('parseDuration rejects signs and decimals', () => { assert.strictEqual(parseDuration('-1d'), null); assert.strictEqual(parseDuration('1.5d'), null); });

test('parseSdTag parses bare tag', () => assert.deepStrictEqual({ valid: parseSdTag('#sd').valid, explicit: parseSdTag('#sd').explicitDelay }, { valid: true, explicit: false }));
test('parseSdTag parses duration', () => assert.strictEqual(parseSdTag('#sd/7d').delayMs, 604800000));
test('parseSdTag parses order-free empty duration', () => { const tag = parseSdTag('#SD/3d/EMPTY'); assert.strictEqual(tag.empty, true); assert.strictEqual(tag.delayMs, 259200000); });
test('parseSdTag parses now', () => { const tag = parseSdTag('#sd/now'); assert.strictEqual(tag.now, true); assert.strictEqual(tag.delayMs, 0); });
test('parseSdTag makes malformed tag inert', () => { const tag = parseSdTag('#sd/3x'); assert.strictEqual(tag.valid, false); assert.strictEqual(tag.inert, true); });
test('parseSdTag makes trailing slash malformed and inert', () => { const tag = parseSdTag('#sd/'); assert.strictEqual(tag.valid, false); assert.strictEqual(tag.inert, true); });
test('parseSdTag rejects duplicate timers', () => assert.strictEqual(parseSdTag('#sd/1d/2d').valid, false));
test('parseSdTag ignores fuzzy sdk', () => assert.strictEqual(parseSdTag('#sdk'), null));

test('tag stamper matcher accepts the #sd family case-insensitively', () => {
  for (const value of ['#sd', '#SD/7d', '  #sd/empty/1d  ']) assert.strictEqual(matchesSdTagText(value), true);
});
test('tag stamper matcher rejects non-sd and embedded text', () => {
  for (const value of ['#keep', '#sdk', 'prefix #sd', '#sdx/1d']) assert.strictEqual(matchesSdTagText(value), false);
});

test('mergeSdTags applies default delay', () => assert.strictEqual(mergeSdTags(['#sd'], parseDuration('3d')).delayMs, parseDuration('3d')));
test('mergeSdTags takes latest deadline and ORs empty', () => { const merged = mergeSdTags(['#sd/now', '#sd/empty/7d'], parseDuration('3d')); assert.strictEqual(merged.delayMs, parseDuration('7d')); assert.strictEqual(merged.empty, true); });
test('mergeSdTags leaves malformed-only set inert', () => { const merged = mergeSdTags(['#sd/banana'], parseDuration('3d')); assert.strictEqual(merged.valid, false); assert.strictEqual(merged.inert, true); });
test('mergeSdTags makes whole line inert when any tag is malformed', () => { const merged = mergeSdTags(['#sd/empty/3x', '#sd/2d'], parseDuration('3d')); assert.strictEqual(merged.valid, false); assert.strictEqual(merged.inert, true); assert.strictEqual(merged.malformedTags.length, 1); });

test('computeDeadline accepts Date basis', () => assert.strictEqual(computeDeadline(new Date(1000), 500), 1500));
test('computeDeadline rejects missing basis', () => assert.strictEqual(computeDeadline(null, 500), null));
test('computeDeadline rejects negative delay', () => assert.strictEqual(computeDeadline(1000, -1), null));

test('lineText joins string and titled segments', () => assert.strictEqual(lineText({ segments: [text(' A '), { type: 'ref', text: { guid: 'g', title: 'Page' } }] }), 'A Page'));
test('lineText omits untitled object segments', () => assert.strictEqual(lineText({ segments: [text('A'), { type: 'ref', text: { guid: 'g' } }] }), 'A'));

test('parseAttrLine adopts bare attribute grammar', () => { const match = parseAttrLine('Focus::'); assert.strictEqual(match[1], 'Focus'); assert.strictEqual(match[2], undefined); });
test('parseAttrLine adopts spaced value grammar', () => { const match = parseAttrLine('Status:: done'); assert.strictEqual(match[2], 'done'); });
test('parseAttrLine adopts no-space human value grammar', () => { const match = parseAttrLine('Owner::Svy'); assert.strictEqual(match[2], 'Svy'); });
test('parseAttrLine rejects C++ code noise', () => assert.strictEqual(parseAttrLine('std::vector'), null));
test('parseAttrLine accepts punctuation in human keys', () => assert.ok(parseAttrLine('Truth, Goodness & Beauty::')));

test('classifyLine treats blank as empty', () => assert.strictEqual(classifyLine(line([text('  ')])).empty, true));
test('classifyLine treats hashtag-only as empty', () => assert.strictEqual(classifyLine(line([hashtag('#topic')])).empty, true));
test('classifyLine treats bare attribute as empty', () => assert.strictEqual(classifyLine(line([text('Focus::')])).empty, true));
test('classifyLine treats filled attribute as content', () => assert.strictEqual(classifyLine(line([text('Focus:: ship')])).empty, false));
test('classifyLine treats ordinary text as content', () => assert.strictEqual(classifyLine(line([text('ship it')])).empty, false));
test('classifyLine treats dc colon markers as scaffold', () => assert.deepStrictEqual(classifyLine(line([text('dc: @"Rich Tasks" and ...')])), { empty: true, reason: 'dc-marker' }));
test('classifyLine treats dc.js call markers as scaffold', () => assert.deepStrictEqual(classifyLine(line([text('dc.js(q): body')])), { empty: true, reason: 'dc-marker' }));
test('classifyLine reconstructs dc markers across native ref segments', () => assert.strictEqual(classifyLine(line([text('dc: '), { type: 'ref', text: { guid: 'g', title: 'Rich Tasks' } }])).reason, 'dc-marker'));
test('classifyLine does not treat dcx as scaffold', () => assert.strictEqual(classifyLine(line([text('dcx: nope')])).empty, false));
test('classifyLine keeps unrelated plain text as content', () => assert.strictEqual(classifyLine(line([text('documentation: body')])).empty, false));
test('classifyLine keeps native query line types as content', () => assert.strictEqual(classifyLine(line([text('dc: query')], 'query')).empty, false));
test('classifyLine treats any task status as content', () => assert.strictEqual(classifyLine(line([text('')], 'task', 'done')).reason, 'task'));
test('classifyLine treats semantic segments as content', () => { for (const type of ['ref','datetime','linkobj','mention']) assert.strictEqual(classifyLine(line([{ type, text: '' }])).empty, false); });
test('classifyLine treats media and transclusion line types as content', () => { for (const type of ['image','file','transclusion']) assert.strictEqual(classifyLine(line([], type)).empty, false); });
test('classifyLine treats non-empty-eligible SDK line types as content', () => { for (const type of ['media','query','ref','table']) assert.strictEqual(classifyLine(line([], type)).empty, false); });

test('isSubtreeEmpty accepts blank hashtag and bare attributes', () => assert.strictEqual(isSubtreeEmpty([line([text('')]), line([hashtag('#x')]), line([text('Focus::')])]), true));
test('isSubtreeEmpty rejects one content descendant', () => assert.strictEqual(isSubtreeEmpty([line([text('')]), line([text('answer')])]), false));
test('isSubtreeEmpty accepts no descendants', () => assert.strictEqual(isSubtreeEmpty([]), true));

test('hasKeepTag vetoes keep roots and namespaces case-insensitively', () => {
  assert.strictEqual(hasKeepTag([hashtag('#keep')]), true);
  assert.strictEqual(hasKeepTag([hashtag('#KEEP/x')]), true);
});
test('hasKeepTag does not match keeper', () => assert.strictEqual(hasKeepTag([hashtag('#keeper')]), false));

test('empty destruct leaf treats bare attribute as delete-eligible', () => assert.strictEqual(isEmptyDestructTarget(line([text('Notes:: '), hashtag('#sd/empty')]), []), true));
test('empty destruct leaf treats filled attribute as content', () => assert.strictEqual(isEmptyDestructTarget(line([text('Notes:: filled '), hashtag('#sd/empty')]), []), false));

test('defusedSegments strips all strict sd tags', () => assert.deepStrictEqual(defusedSegments([hashtag('#sd'), text(' '), hashtag('#SD/7d')]), [{ type: 'text', text: '' }]));
test('defusedSegments preserves fuzzy sdk', () => assert.deepStrictEqual(defusedSegments([hashtag('#sdk')]), [hashtag('#sdk')]));
test('defusedSegments collapses whitespace seam', () => assert.deepStrictEqual(defusedSegments([text('Alpha '), hashtag('#sd'), text(' beta')]), [text('Alpha beta')]));
test('defusedSegments removes leading tag whitespace', () => assert.deepStrictEqual(defusedSegments([hashtag('#sd'), text(' Alpha')]), [text('Alpha')]));
test('defusedSegments keeps a tight seam tight', () => assert.deepStrictEqual(defusedSegments([text('Alpha'), hashtag('#sd'), text('beta')]), [text('Alphabeta')]));
test('defusedSegments rtrims trailing text', () => assert.deepStrictEqual(defusedSegments([text('Alpha '), hashtag('#sd')]), [text('Alpha')]));
test('defusedSegments does not mutate source segments', () => { const source = [text('Alpha '), hashtag('#sd')]; defusedSegments(source); assert.strictEqual(source[0].text, 'Alpha '); });
test('defusedSegments preserves datetime object identity', () => { const dateTime = { kind: 'date', value: '2026-07-31' }; const output = defusedSegments([{ type: 'datetime', text: dateTime }, hashtag('#sd')]); assert.strictEqual(output[0].text, dateTime); });

test('formatCountdown reports due', () => assert.strictEqual(formatCountdown(0), 'due'));
test('formatCountdown reports negative values as due', () => assert.strictEqual(formatCountdown(-5), 'due'));
test('formatCountdown reports sub-minute', () => assert.strictEqual(formatCountdown(59999), '<1m'));
test('formatCountdown reports two largest units', () => assert.strictEqual(formatCountdown(parseDuration('1w') + parseDuration('2d') + parseDuration('3h')), '1w 2d'));
test('formatCountdown reports hours and minutes', () => assert.strictEqual(formatCountdown(parseDuration('2h') + parseDuration('5m')), '2h 5m'));
test('formatCountdown reports unknown', () => assert.strictEqual(formatCountdown(Number.NaN), 'unknown'));

test('twenty unchanged caret-line bursts emit zero Self Destruct class writes', () => {
  const lineGuid = '1SDZEROWRITEBURSTABCDEFGHI';
  let classWrites = 0;
  const makeClassList = values => ({
    values: new Set(values),
    contains(value) { return this.values.has(value); },
    add(value) { classWrites++; this.values.add(value); },
    remove(value) { classWrites++; this.values.delete(value); },
  });
  const row = { isConnected: true, classList: makeClassList(['sd-tag-caret-line']) };
  const chip = {
    classList: makeClassList(['sd-tag-hide']),
    closest(selector) { return selector === '.listview-items[data-guid]' ? null : row; },
  };
  const p = Object.create(Plugin.prototype);
  p._disposed = false;
  p._tagCaretLineEl = row;
  p._tagCaretLineGuid = lineGuid;
  p._currentCaretGuid = () => lineGuid;
  p._templateGuidsReady = true;
  p._templateGuids = new Set();
  p._findSdChips = () => [chip];
  p._lastFindUsedFallback = false;

  for (let i = 0; i < 20; i++) {
    p._stashCaretGuid();
    p._scanSdChips(row);
  }

  assert.strictEqual(classWrites, 0);
  assert.strictEqual(row.classList.contains('sd-tag-caret-line'), true);
  assert.strictEqual(chip.classList.contains('sd-tag-hide'), true);
});

test('caret stash re-applies an externally stripped caret-line class on the same node', () => {
  const lineGuid = '1SDCARETREPAIRABCDEFGHIJKL';
  let pluginClassWrites = 0;
  const values = new Set(['sd-tag-caret-line']);
  const row = {
    isConnected: true,
    classList: {
      contains(value) { return values.has(value); },
      add(value) { pluginClassWrites++; values.add(value); },
      remove(value) { pluginClassWrites++; values.delete(value); },
    },
  };
  const previousDocument = global.document;
  const previousCss = global.CSS;
  global.document = { querySelector: () => row };
  global.CSS = { escape: value => String(value) };
  try {
    const p = Object.create(Plugin.prototype);
    p._disposed = false;
    p._tagCaretLineEl = row;
    p._tagCaretLineGuid = lineGuid;
    p._currentCaretGuid = () => lineGuid;

    values.delete('sd-tag-caret-line'); // external in-place renderer mutation
    p._stashCaretGuid();

    assert.strictEqual(pluginClassWrites, 1);
    assert.strictEqual(row.classList.contains('sd-tag-caret-line'), true);
  } finally {
    global.document = previousDocument;
    global.CSS = previousCss;
  }
});

console.log('PASS ' + passed + ' tests');
