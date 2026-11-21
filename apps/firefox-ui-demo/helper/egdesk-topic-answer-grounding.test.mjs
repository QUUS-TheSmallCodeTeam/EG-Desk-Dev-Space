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
