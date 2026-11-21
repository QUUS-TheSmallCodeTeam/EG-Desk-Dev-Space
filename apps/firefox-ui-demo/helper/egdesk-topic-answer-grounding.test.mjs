import test from 'node:test'
import assert from 'node:assert/strict'
import { topicAnswerContradiction as check } from './egdesk-topic-answer-grounding.mjs'

test('fixed contrasts recognize assertive identity, permission, and recovery, not the word alone', () => {
  for (const [text, reason] of [
    ['“동의 세대”는 EG-Desk의 공식 설정입니다.', 'term-identity'],
    ['The consent generation is an official settings option.', 'term-identity'],
    ['주제 기억은 동의 없이도 작동합니다.', 'permission'],
    ['Topic Memory works without explicit consent.', 'permission'],
    ['주제 기억은 철회한 뒤 자동으로 복구됩니다.', 'recovery'],
    ['Topic Memory automatically restores after revocation.', 'recovery'],
    ['동의 세대는 설정이 아닙니다. 주제 기억은 삭제 뒤 자동으로 복원됩니다.', 'recovery'],
  ]) assert.equal(check(text), reason, text)
  for (const text of [
    '“동의 세대는 공식 설정입니다.”',
    '동의 세대는 공식 설정인가요?',
    '“동의 세대”는 공식 설정이 아닙니다.',
    '이 대화에서만 “동의 세대”를 임시 용어로 쓰겠습니다.',
    '주제 기억은 이 DM에서 별도로 허용해야 합니다.',
    '주제 기억은 동의 없이 작동하지 않습니다.',
    '주제 기억은 철회 뒤 자동으로 복구되지 않습니다.',
    'Does Topic Memory automatically restore after revocation?',
    'Topic Memory does not automatically restore after revocation.',
    'Did you call it “동의 세대”? 점심부터 먹어요.',
  ]) assert.equal(check(text), null, text)
})

for (const [contrast, cases] of [
  ['identity', [
    [null, '주제 기억에는 ‘동의 세대’라는 설정이 없습니다.'],
    [null, '설정 메뉴에 ‘동의 세대’라는 항목은 없어요.'],
    ['term-identity', '‘동의 세대’는 임시 표현이 아니라 공식 설정입니다.'],
    [null, '‘동의 세대’는 공식 설정이 아니라 임시 표현입니다.'],
    ['term-identity', '‘동의 세대’는 공식 설정입니다.'],
    [null, '“동의 세대는 임시 표현이 아니라 공식 설정입니다.”'],
    [null, '‘동의 세대’라는 표현은 이 대화에서만 씁니다.'],
    [null, '계정 메뉴에는 ‘실험 세대’라는 설정이 없습니다.'],
  ]],
  ['permission', [
    [null, '주제 기억은 별도 동의 없이 켤 수 없습니다.'],
    ['permission', '주제 기억은 별도 동의 없이 켤 수 있습니다.'],
    ['permission', '주제 기억에 별도 동의가 필요 없어요.'],
    [null, '주제 기억은 동의가 필요 없다는 말은 사실이 아닙니다.'],
    [null, '“주제 기억은 동의 없이 켤 수 있습니다.”'],
    [null, '문서 편집에는 별도 동의가 필요 없어요.'],
  ]],
  ['recovery', [
    [null, '주제 기억이 철회 뒤 자동으로 복구된다는 말은 사실이 아닙니다.'],
    [null, '주제 기억은 철회하면 자동 복구가 불가능합니다.'],
    ['recovery', '주제 기억은 철회 뒤 자동으로 복구됩니다.'],
    ['recovery', '주제 기억은 철회 뒤 자동 복구가 안 되는 게 아니라 자동 복구됩니다.'],
    [null, '“주제 기억은 철회 뒤 자동으로 복구됩니다.”'],
    [null, '철회한 주문은 자동으로 복구됩니다.'],
  ]],
]) test(`natural Korean grounding: ${contrast}`, async t => {
  for (const [expected, text] of cases) await t.test(text, () => assert.equal(check(text), expected))
})
