// Public synthetic Korean wiki (32 pages). Invented companies, people and numbers; no private data.
const P = (id, title, body, slice, kind, status, links = [], extra = {}) => ({ id, title, body, revision: '1', time: { slice, ...(extra.at ? { at: extra.at } : {}) },
  provenance: { kind, ...(extra.by ? { by: extra.by } : {}) }, status, links, ...(extra.scope ? { scope: extra.scope } : {}) })
export const SYNTHETIC_PAGES = [
  // A사 견적 건
  P('quote/a-request', 'A사 견적 요청 접수', 'A사 구매팀이 11월 3일 스피커 모듈 200개 견적을 요청했다. 희망 납기는 12월 중순이다.', 'past', 'own_record', 'done', [], { at: '2026-11-03' }),
  P('quote/a-v1', 'A사 견적서 v1 발송', '11월 6일 단가 12,800원으로 견적서 v1을 발송했다. A사 회신을 기다리는 중이다.', 'past', 'own_record', 'done',
    [{ type: 'follows_from', to: 'quote/a-request' }, { type: 'same_task', to: 'quote/a-request' }], { at: '2026-11-06' }),
  P('quote/a-meeting', 'A사 단가 협의 메모', '팀장 말로는 A사가 단가를 11,900원으로 낮춰 달라고 했다고 함. 직접 확인한 것은 아니고 확정도 아니다.', 'past', 'reported_by_other', 'reported_by_other',
    [{ type: 'refers_to', to: 'quote/a-v1' }, { type: 'same_task', to: 'quote/a-request' }], { at: '2026-11-14', by: '팀장' }),
  P('quote/a-v2-plan', 'A사 견적서 v2 수정 계획', '단가 12,200원, 납기 12월 20일로 견적서 v2를 보낼 예정이다. 아직 발송하지 않았다. 팀장 승인 후 발송한다.', 'planned', 'own_record', 'plan',
    [{ type: 'supersedes', to: 'quote/a-v1' }, { type: 'decided_in', to: 'quote/a-decision' }, { type: 'same_task', to: 'quote/a-request' }]),
  P('quote/a-decision', 'A사 건 결정 메모', '11월 18일 회의에서 v2는 팀장 승인 후 발송하기로 결정했다. 승인 기한은 11월 25일이다.', 'past', 'own_record', 'done',
    [{ type: 'same_task', to: 'quote/a-request' }], { at: '2026-11-18' }),
  P('quote/b-request', 'B사 견적 요청', 'B사가 11월 10일 케이스 500개 견적을 요청했다. 단가 협의 전이다.', 'past', 'own_record', 'done', [], { at: '2026-11-10' }),
  P('quote/b-v1', 'B사 견적서 v1 발송', '11월 12일 B사에 케이스 견적서 v1을 발송했다. 회신 없음.', 'past', 'own_record', 'done', [{ type: 'follows_from', to: 'quote/b-request' }], { at: '2026-11-12' }),
  P('quote/c-contract', 'C사 계약 검토', 'C사 공급 계약서 3조 지급 조건을 검토 중이다. 법무 의견 대기.', 'present', 'document', 'plan'),
  P('quote/parts', '스피커 모듈 부품표', '스피커 모듈 BOM: 드라이버 1, 앰프 칩 1, 단자 2. 부품 수급은 안정적이다.', 'present', 'document', 'done'),
  P('quote/a-cost', 'A사 내부 원가 메모(비공개 범위)', 'A사 건 내부 원가는 단가의 71%다. 이 메모는 다른 대화방에서만 쓴다.', 'past', 'own_record', 'done', [{ type: 'same_task', to: 'quote/a-request' }], { scope: 'dm:other-room' }),
  // PostgreSQL 마이그레이션
  P('db/pg-design', 'PostgreSQL 전환 설계', 'SQLite에서 PostgreSQL로 옮기는 설계를 확정했다. 스키마 변환, 데이터 이관, 롤백 순서를 정의했다.', 'past', 'document', 'done', [], { at: '2026-11-12' }),
  P('db/pg-plan', 'PostgreSQL 마이그레이션 배포 계획', '12월 첫째 주에 SQLite에서 PostgreSQL로 전환 배포할 예정이다. 배포 뒤 헬스체크 3종을 통과해야 한다. 아직 배포 전이다.', 'planned', 'own_record', 'plan',
    [{ type: 'follows_from', to: 'db/pg-design' }, { type: 'supersedes', to: 'db/sqlite-schema' }, { type: 'refers_to', to: 'db/pg-health' }, { type: 'refers_to', to: 'db/pg-rollback' }]),
  P('db/pg-health', '헬스체크 3종 체크리스트', '헬스체크 3종: 연결 풀 응답, 쓰기 지연 50ms 이하, 복제 지연 없음. 전부 통과하면 배포 성공으로 본다.', 'present', 'document', 'done'),
  P('db/sqlite-schema', '현재 SQLite 스키마(운영)', '현재 운영 DB는 SQLite이며 테이블은 users, orders, quotes 세 개다. 배포 전까지 이 스키마가 현재 운영 기준이다.', 'present', 'document', 'done'),
  P('db/pg-followup', '배포 후 후속 체크리스트', '배포 직후: 알림 채널 확인, 캐시 비우기, 구 SQLite 백업 7일 보관, 헬스체크 결과 기록. 모두 끝나면 전환 완료로 본다.', 'present', 'document', 'plan', [{ type: 'follows_from', to: 'db/pg-plan' }]),
  P('db/pg-rollback', '롤백 절차', '문제가 생기면 SQLite 백업으로 30분 안에 되돌린다. 롤백 판단은 헬스체크 실패 시점에 한다.', 'present', 'document', 'done', [{ type: 'follows_from', to: 'db/pg-design' }]),
  P('db/pg-bench', '전환 벤치마크 결과', '테스트 환경 벤치마크: 쓰기 지연이 SQLite 대비 평균 18% 줄었다. 운영 수치는 아니다.', 'past', 'agent_note', 'done', [{ type: 'refers_to', to: 'db/pg-design' }], { at: '2026-11-16' }),
  P('db/redis', 'Redis 캐시 도입 검토', '세션 캐시로 Redis를 쓸지 검토 중이다. 결정 전이다.', 'hypothetical', 'document', 'plan'),
  // jev hook 흐름
  P('jev/flow-note', 'jev hook 흐름 메모(오늘 오전)', '흐름: 1) 사용자 입력에서 시제를 가른다 2) 자료를 인출한다 3) 자료에 시제 머리말을 붙인다 4) 답 초안을 검증한다 5) 완료 보고는 전이 제안으로 돌린다.', 'past', 'agent_note', 'done',
    [{ type: 'follows_from', to: 'jev/utt-user' }, { type: 'refers_to', to: 'jev/draft' }], { at: '2026-11-24' }),
  P('jev/utt-user', '오늘 오전 사용자 발언: hook 위치', '사용자: "hook은 PreToolUse에서만 돌리는 게 맞아." (본인 의견, 사실 확인 아님)', 'past', 'utterance', 'unknown', [{ type: 'same_task', to: 'jev/flow-note' }], { at: '2026-11-24', by: '사용자' }),
  P('jev/utt-agent', '오늘 오전 Agent 발언: 사후 검증', 'Agent: "PostToolUse에서도 검증은 할 수 있다고 설명했다." (설명이며 구현 완료 아님)', 'past', 'utterance', 'unknown', [{ type: 'same_task', to: 'jev/flow-note' }, { type: 'follows_from', to: 'jev/utt-user' }], { at: '2026-11-24', by: 'Agent' }),
  P('jev/draft', 'jev hook 설계 초안', '초안: PreToolUse 훅은 시제 라벨만 붙이고 판단 결과는 쓰기 권한이 아니다. 아직 확정되지 않은 가설이다.', 'hypothetical', 'document', 'plan', [{ type: 'decided_in', to: 'jev/flow-note' }]),
  P('jev/gc', '해마 GC 데몬 구상', '유휴 시간에 임시 기록을 정리하는 데몬 구상. 구현 계획 없음.', 'hypothetical', 'document', 'plan'),
  P('jev/alt', 'jev 오픈소스 대안 비교표', '대안 4종 비교: 지연, 정확도, 라이선스. 로컬 구현 후보 표다.', 'past', 'document', 'done'),
  // 기타 (무관)
  P('misc/board-layout', 'Board 레이아웃 메모', '카드 두 장 폭 배치는 664px 이상에서만 쓴다.', 'present', 'document', 'done'),
  P('misc/dinner', '팀 회식 일정', '12월 5일 저녁 7시 회식. 장소 미정.', 'planned', 'document', 'plan'),
  P('misc/tokens', '디자인 토큰 정리', '색상 토큰 12개를 8개로 줄였다.', 'past', 'document', 'done'),
  P('misc/retro', '11월 회고 초안', '11월 회고: 견적 응대가 느렸다는 의견이 있었다(작성 중).', 'present', 'document', 'plan'),
  P('misc/onboarding', '온보딩 문서', '신규 입사자 첫 주 일정과 계정 발급 순서.', 'present', 'document', 'done'),
  P('misc/account', '계정 설정 가이드', '계정 연결과 키 설정 위치 안내.', 'present', 'document', 'done'),
  P('misc/release', '릴리스 노트 v0.9', 'v0.9: 카드 정렬 개선, 설정 화면 정리.', 'past', 'document', 'done', [], { at: '2026-11-08' }),
  P('misc/testplan', '테스트 계획', '회귀 테스트 목록과 담당자.', 'present', 'document', 'plan'),
]
export const SCENARIOS = [
  { message: '지난주 A사 견적 건 어디까지 됐지?', note: '질문의 시각 기준 지난주 = 11월 중순' },
  { message: 'PostgreSQL 마이그레이션 배포 끝났어', note: '완료 보고: 계획 문서는 계획 그대로, 전이는 제안' },
  { message: '아까 jev hook 흐름 다시 정리해줘', note: '같은 날 오전 대화·메모' },
]

// A LEXICAL STAND-IN for the Decision model, for offline tests only. It reads the page text in the request and scores
// character-bigram overlap with the message; it says nothing about how a real model would judge.
const bigrams = text => { const s = String(text).replace(/\s+/g, '').toLowerCase(); const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out }
const STOP = new Set(['어디', '디까', '까지', '됐지', '끝났', '났어', '정리', '리해', '해줘', '줘', '다시', '아까'])
const overlap = (message, text) => { const m = [...bigrams(message)].filter(b => !STOP.has(b)); const t = bigrams(text); return m.length ? m.filter(b => t.has(b)).length / m.length : 0 }
const blocksOf = (contents, header) => {
  const content = [].concat(contents).find(c => c.startsWith(header)); if (content === undefined) return []
  const at = 0
  const body = content.slice(at + header.length).split(/\n\n(?=P\d+ \|)/)
  return body.map(b => { const m = /^(P\d+) \| ([^\n]*)\n([\s\S]*)$/.exec(b); return m ? { alias: m[1], head: m[2], text: m[3].split('\n(reached by link')[0], link: /reached by link: ([^)]*)/.exec(b)?.[1] ?? '' } : null }).filter(Boolean)
}
const statusOf = (head, text) => {
  if (/provenance=reported_by_other/.test(head) || /라고 함|전언/.test(text)) return 'reported_by_other'
  if (/provenance=utterance/.test(head)) return 'unknown' // a spoken remark is not shown to be plan or done by its own content
  if (/later-record-supersedes=yes/.test(head)) return 'superseded'
  if (/아직 .{0,8}(않았|전이다)|예정이다|할 예정|검토 중|결정 전|가설|구상/.test(text)) return 'plan'
  if (/했다|확정했다|통과|이다\./.test(text)) return 'done'
  return 'unknown'
}
const COMPLETION = /끝났|완료|마쳤/
const CHIT = /^(고마워|감사|ㅎㅎ|ㅋㅋ|안녕|수고|넵|네$|응$)/
export const choiceAnswer = (question, value, top, confidence = null) => {
  const values = question.choices.map(c => c.value), rest = (1 - top) / Math.max(1, values.length - 1)
  const rows = [{ value, probability: top }, ...values.filter(v => v !== value).map(v => ({ value: v, probability: rest }))]
  const n = values.length
  return { type: 'choice', choice: value, confidence: confidence ?? (top - 1 / n) / (1 - 1 / n), probabilities: rows }
}
const quoteOf = question => { const m = /quoted exactly as a JSON string: ("(?:[^"\\]|\\.)*")/.exec(question.instructions ?? ''); try { return m ? JSON.parse(m[1]) : '' } catch { return '' } }
// Scripted, not a model: reads markers in the sentence and mimics the real isolated-axes result pattern (a decisive time/form,
// a weak source label for an unmarked sentence, so a label is not installed when its confidence is low).
export function mockSpeechAnswer(question) {
  const text = quoteOf(question), axis = question.name.split('_')[1]
  if (axis === 'source') return /들었|라고 했|라고 함|전언/.test(text) ? choiceAnswer(question, 'attributed_report', 0.97) : choiceAnswer(question, 'unspecified', 0.55)
  if (axis === 'form') return /[?？]\s*$|지\?|까\?/.test(text) ? choiceAnswer(question, 'question', 0.97) : /예정|할게|할 거|겠/.test(text) ? choiceAnswer(question, 'plan', 0.97) : choiceAnswer(question, 'assertion', 0.93)
  return /어제|지난/.test(text) ? choiceAnswer(question, 'past_anchored', 0.93) : /끝났|했어|했다|됐/.test(text) ? choiceAnswer(question, 'past_unspecified', 0.93) : /내일|다음/.test(text) ? choiceAnswer(question, 'future_anchored', 0.95) : /지금|현재/.test(text) ? choiceAnswer(question, 'at_utterance', 0.93) : choiceAnswer(question, 'unknown', 0.9)
}
export function mockJudge(log = []) {
  return { async decide(request) {
    const texts = request.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    const joined = texts.join('\n\n'), message = /Message:\n([\s\S]*)$/.exec(joined)?.[1] ?? ''
    const next = /MID-CONVERSATION/.test(texts[0] ?? ''), heldTitles = [...(texts.find(t => t.startsWith('Held in'))?.matchAll(/^- (.+?) \|/gm) ?? [])].map(m => m[1]).join(' ')
    log.push({ questions: request.questions.map(q => q.name), input: joined, next, bytes: Buffer.byteLength(JSON.stringify({ input: request.input, questions: request.questions })), choiceQ: request.questions.filter(q => q.type === 'choice').length, predQ: request.questions.filter(q => q.type === 'predicate').length })
    const answers = {}
    const chit = CHIT.test(message.trim()), isQuestion = /[?？]\s*$/.test(message.trim())
    for (const q of request.questions) {
      if (q.name === 'tn_courtesy') answers[q.name] = { type: 'predicate', probability: chit ? 0.97 : 0.02 }
      else if (q.name === 'tn_need') answers[q.name] = { type: 'predicate', probability: chit ? 0.03 : 0.9 }
      else if (q.name === 'tn_record') answers[q.name] = { type: 'predicate', probability: !chit && !isQuestion && /(어|야|다|요)\.?$/.test(message.trim()) ? 0.95 : 0.03 }
      else if (q.name === 'tw_status') answers[q.name] = COMPLETION.test(message) ? choiceAnswer(q, 'done', 0.95) : /예정|할 거|할게/.test(message) ? choiceAnswer(q, 'plan', 0.95) : choiceAnswer(q, 'unknown', 0.9)
      else if (/^speech_/.test(q.name)) answers[q.name] = mockSpeechAnswer(q)
    }
    const cands = blocksOf(texts, 'Candidate pages:\n')
    if (request.questions.some(q => q.name === 'tw_target')) {
      const q = request.questions.find(x => x.name === 'tw_target')
      let pick = 'none'
      if (!chit && !isQuestion) {
        const hit = cands.find(b => /provenance=/.test(b.head) && /예정|계획|아직/.test(b.text) && overlap(message, b.head + ' ' + b.text) >= 0.15)
        pick = COMPLETION.test(message) && hit ? hit.alias : 'new'
      }
      answers.tw_target = choiceAnswer(q, pick, 0.93)
      cands.forEach(b => { answers[`tw_link_${Number(b.alias.slice(1)) - 1}`] = { type: 'predicate', probability: overlap(message, b.head + ' ' + b.text) >= 0.15 ? 0.9 : 0.05 } })
    }
    for (const b of blocksOf(texts, 'Pages:\n')) {
      const s = overlap(message + (next ? ' ' + heldTitles : ''), b.head + ' ' + b.text) + (/A사/.test(message) && /A사/.test(b.text + b.head) ? 0.2 : 0)
      const needNext = next && COMPLETION.test(message)
      const p = needNext ? (/후속|체크리스트|헬스체크|통과|보관/.test(b.text) && s >= 0.06 ? 0.95 : 0.03) : (s >= 0.34 ? 0.95 : s >= 0.2 ? 0.5 : 0.03)
      answers[`pg_${Number(b.alias.slice(1)) - 1}`] = { type: 'predicate', probability: p }
    }
    for (const b of blocksOf(texts, 'Picked pages:\n')) { const s = statusOf(b.head, b.text)
      answers[`st_${b.alias}`] = { type: 'choice', choice: s, confidence: 0.9, probabilities: [{ value: s, probability: 0.9 }, { value: 'unknown', probability: 0.05 }] } }
    for (const b of blocksOf(texts, 'Linked pages you may open:\n')) {
      const strong = /type (supersedes|decided_in|follows_from|same_task)/.test(b.link), s = overlap(message, b.head + ' ' + b.text)
      answers[`op_${b.alias}`] = { type: 'predicate', probability: (strong && (s >= 0.1 || /supersedes|decided_in/.test(b.link))) || s >= 0.34 ? 0.92 : /second look/.test(b.link) && (s >= 0.25 || (/A사/.test(message) && /A사/.test(b.head + b.text))) ? 0.9 : 0.1 } }
    return { answers, usage: { inputTokens: Math.round(joined.length * 0.5) }, latencyMs: 5, model: 'lexical-stand-in' }
  } }
}
