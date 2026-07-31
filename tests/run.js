'use strict';

global.AppPlugin = class AppPlugin {};
global.window = {};

const assert = require('assert');
const {
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
test('parseSdTag rejects duplicate timers', () => assert.strictEqual(parseSdTag('#sd/1d/2d').valid, false));
test('parseSdTag ignores fuzzy sdk', () => assert.strictEqual(parseSdTag('#sdk'), null));

test('mergeSdTags applies default delay', () => assert.strictEqual(mergeSdTags(['#sd'], parseDuration('3d')).delayMs, parseDuration('3d')));
test('mergeSdTags takes latest deadline and ORs empty', () => { const merged = mergeSdTags(['#sd/now', '#sd/empty/7d'], parseDuration('3d')); assert.strictEqual(merged.delayMs, parseDuration('7d')); assert.strictEqual(merged.empty, true); });
test('mergeSdTags leaves malformed-only set inert', () => { const merged = mergeSdTags(['#sd/banana'], parseDuration('3d')); assert.strictEqual(merged.valid, false); assert.strictEqual(merged.inert, true); });
test('mergeSdTags keeps valid timer alongside malformed tag', () => { const merged = mergeSdTags(['#sd/banana', '#sd/2d'], parseDuration('3d')); assert.strictEqual(merged.valid, true); assert.strictEqual(merged.malformedTags.length, 1); });

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
test('classifyLine treats any task status as content', () => assert.strictEqual(classifyLine(line([text('')], 'task', 'done')).reason, 'task'));
test('classifyLine treats semantic segments as content', () => { for (const type of ['ref','datetime','linkobj','mention']) assert.strictEqual(classifyLine(line([{ type, text: '' }])).empty, false); });
test('classifyLine treats media and transclusion line types as content', () => { for (const type of ['image','file','transclusion']) assert.strictEqual(classifyLine(line([], type)).empty, false); });

test('isSubtreeEmpty accepts blank hashtag and bare attributes', () => assert.strictEqual(isSubtreeEmpty([line([text('')]), line([hashtag('#x')]), line([text('Focus::')])]), true));
test('isSubtreeEmpty rejects one content descendant', () => assert.strictEqual(isSubtreeEmpty([line([text('')]), line([text('answer')])]), false));
test('isSubtreeEmpty accepts no descendants', () => assert.strictEqual(isSubtreeEmpty([]), true));

test('defusedSegments strips all strict sd tags', () => assert.deepStrictEqual(defusedSegments([hashtag('#sd'), text(' '), hashtag('#SD/7d')]), [{ type: 'text', text: '' }]));
test('defusedSegments preserves fuzzy sdk', () => assert.deepStrictEqual(defusedSegments([hashtag('#sdk')]), [hashtag('#sdk')]));
test('defusedSegments collapses whitespace seam', () => assert.deepStrictEqual(defusedSegments([text('Alpha '), hashtag('#sd'), text(' beta')]), [text('Alpha beta')]));
test('defusedSegments removes leading tag whitespace', () => assert.deepStrictEqual(defusedSegments([hashtag('#sd'), text(' Alpha')]), [text('Alpha')]));
test('defusedSegments keeps a tight seam tight', () => assert.deepStrictEqual(defusedSegments([text('Alpha'), hashtag('#sd'), text('beta')]), [text('Alphabeta')]));
test('defusedSegments rtrims trailing text', () => assert.deepStrictEqual(defusedSegments([text('Alpha '), hashtag('#sd')]), [text('Alpha')]));
test('defusedSegments does not mutate source segments', () => { const source = [text('Alpha '), hashtag('#sd')]; defusedSegments(source); assert.strictEqual(source[0].text, 'Alpha '); });

test('formatCountdown reports due', () => assert.strictEqual(formatCountdown(0), 'due'));
test('formatCountdown reports sub-minute', () => assert.strictEqual(formatCountdown(59999), '<1m'));
test('formatCountdown reports two largest units', () => assert.strictEqual(formatCountdown(parseDuration('1w') + parseDuration('2d') + parseDuration('3h')), '1w 2d'));
test('formatCountdown reports hours and minutes', () => assert.strictEqual(formatCountdown(parseDuration('2h') + parseDuration('5m')), '2h 5m'));
test('formatCountdown reports unknown', () => assert.strictEqual(formatCountdown(Number.NaN), 'unknown'));

console.log('PASS ' + passed + ' tests');
