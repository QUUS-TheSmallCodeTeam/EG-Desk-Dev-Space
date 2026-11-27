// Synthetic public fixtures for the working-memory gate. No real project, person, site or log is quoted.
import { normalizeDecisionResponse } from './egdesk-decision-client.mjs'

/** 300-line build log, exit 1, with ONE real error (three lines) in the middle and the usual harmless noise around it. */
export function buildLog() {
  const lines = ['$ npm run build', '> sample-shop@1.4.0 build', '> tsc -p . && vite build', '']
  for (let i = 1; i <= 140; i++) lines.push(`[${String(i).padStart(3, ' ')}/280] 컴파일 src/modules/mod_${i}.ts (${12 + (i * 7) % 90} ms)`)
  lines.push('', 'src/checkout/payment.ts:88:17 - error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.', '88   const total = addTax(cart.total, region)', '                   ~~~~~~~~~~', '')
  for (let i = 141; i <= 280; i++) lines.push(`[${String(i).padStart(3, ' ')}/280] 컴파일 src/modules/mod_${i}.ts (${12 + (i * 7) % 90} ms)`)
  lines.push('', '경고 0개, 0 errors in dependencies', 'Found 1 error in src/checkout/payment.ts:88', 'npm ERR! code ELIFECYCLE', 'npm ERR! errno 2', 'Build finished with exit code 2')
  while (lines.length < 300) lines.splice(lines.length - 6, 0, `  chunk assets/part-${lines.length}.js  ${(lines.length * 13) % 400}.${lines.length % 10} kB`)
  return { kind: 'build', exitCode: 2, goal: '결제 모듈 빌드 오류를 고쳐 줘 (src/checkout/payment.ts)', paths: ['src/checkout/payment.ts'], text: lines.join('\n'),
    mustKeep: ['src/checkout/payment.ts:88:17 - error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.', 'Found 1 error in src/checkout/payment.ts:88', 'Build finished with exit code 2'] }
}

/** 2,000-line grep over 50 files; the goal names one function, which appears in two files. */
export function grepOutput() {
  const lines = []
  for (let f = 1; f <= 50; f++) {
    for (let n = 1; n <= 40; n++) {
      const special = (f === 7 && n === 12) || (f === 31 && n === 3)
      lines.push(`src/pkg${String(f).padStart(2, '0')}/service_${f}.ts:${n * 9 + f}:  ${special ? 'export function applyRegionalTax(amount: number, region: string) {' : `const taxNote${n} = lookup('tax.${f}.${n}') // 세금 관련 메모 ${n}`}`)
    }
  }
  return { kind: 'search', exitCode: 0, goal: 'applyRegionalTax 함수가 어디서 정의되고 쓰이는지 찾아 줘', paths: [], text: lines.join('\n'),
    mustKeep: ['src/pkg07/service_7.ts:115:  export function applyRegionalTax(amount: number, region: string) {', 'src/pkg31/service_31.ts:58:  export function applyRegionalTax(amount: number, region: string) {'] }
}

/** A five-line result. Never touched. */
export function shortResult() {
  return { kind: 'terminal', exitCode: 0, goal: '테스트 실행', paths: [], text: ['$ node --test', '# tests 12', '# pass 12', '# fail 0', '# duration_ms 418'].join('\n'), mustKeep: [] }
}

/** A browser page dump as an observe-style JSON result: ids the model must cite later plus 409 visible text segments. */
export function pageDump() {
  const text = ['샘플 상점 고객센터', '주문/배송 FAQ', '환불 규정 안내']
  for (let i = 1; i <= 400; i++) text.push(`추천 상품 ${i}: 합성 예시 상품 이름 ${i} · 정가 ${(i * 1300) % 90000 + 5000}원 · 리뷰 ${(i * 17) % 500}건`)
  text.splice(210, 0, '환불은 수령 후 14일 이내에 신청할 수 있습니다.', '개봉한 상품은 환불 수수료 10%가 부과됩니다.', '환불 신청: 마이페이지 > 주문 내역 > 환불 요청')
  text.push('사업자 정보', '고객센터 운영 시간 09:00-18:00', '© 합성 예시 상점')
  const result = { status: 'observed', cardId: 'card-synthetic-1', observationId: 'obs-0007', snapshot: { documentId: 'doc-42', url: 'https://shop.example/help/refund', title: '환불 규정 - 샘플 상점',
    elements: [{ ref: 'e1', role: 'link', name: '환불 요청' }, { ref: 'e2', role: 'button', name: '문의하기' }], text }, externalEffectVerified: false }
  return { kind: 'page', exitCode: null, goal: '"환불 규정" 페이지에서 환불 기한과 수수료를 확인해 줘', paths: [], response: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] },
    mustKeep: ['환불은 수령 후 14일 이내에 신청할 수 있습니다.', '개봉한 상품은 환불 수수료 10%가 부과됩니다.'], ids: ['obs-0007', 'doc-42', 'card-synthetic-1', '"ref":"e1"'] }
}

/**
 * Non-repetitive prose: a long help article as plain page text, twelve sections of distinct sentences.
 * The goal is a paraphrase ("돈을 돌려받을 수 있는지") of one section's heading ("지연 보상 정책"), so no pattern links them.
 */
export function articleDump() {
  const topics = ['회원 가입 안내', '비밀번호 재설정', '주문 방법', '결제 수단', '배송 지역', '교환 절차', '지연 보상 정책', '포인트 적립', '쿠폰 사용', '회원 등급', '고객 문의', '약관 변경 이력']
  const subjects = ['고객은', '담당자는', '시스템은', '상점은', '택배사는', '운영팀은', '회원은', '판매자는']
  const verbs = ['확인합니다', '안내합니다', '기록합니다', '검토합니다', '처리합니다', '보관합니다', '통지합니다', '갱신합니다', '점검합니다', '조정합니다']
  const objects = ['신청 내용을', '접수 순서를', '변경 사항을', '처리 결과를', '예외 조건을', '필요 서류를', '적용 기간을', '진행 상태를', '관련 기록을', '세부 기준을', '남은 절차를']
  const adverbs = ['영업일 기준으로', '접수한 순서대로', '담당 부서에서', '별도 고지 없이', '요청이 있을 때', '매월 초에', '필요한 경우에', '정해진 양식으로', '문서로 남겨', '가능한 한 빨리', '한 번 더', '사전에', '즉시']
  const lines = ['샘플 상점 도움말 전체 보기']
  topics.forEach((topic, t) => {
    lines.push('', `## ${topic}`)
    for (let i = 0; i < 18; i++) {
      const k = t * 18 + i
      lines.push(topic === '지연 보상 정책' && i === 4 ? '예정일보다 사흘 넘게 늦으면 결제 금액의 5%를 돌려드립니다.'
        : topic === '지연 보상 정책' && i === 5 ? '보상 신청은 수령일로부터 30일 안에 해야 합니다.'
        : `${subjects[k % 8]} ${adverbs[(k * 5 + t) % 13]} ${objects[(k * 3 + i) % 11]} ${verbs[(k * 7 + t) % 10]} (${topic.split(' ')[0]} ${'가나다라마바사아자차카타파하'[i % 14]}항)`)
    }
  })
  lines.push('', '문의: help@shop.example')
  return { kind: 'page', exitCode: null, goal: '배송이 늦으면 돈을 돌려받을 수 있는지 알려 줘', paths: [], text: lines.join('\n'),
    mustKeep: ['예정일보다 사흘 넘게 늦으면 결제 금액의 5%를 돌려드립니다.', '보상 신청은 수령일로부터 30일 안에 해야 합니다.'], relevantHeading: '## 지연 보상 정책' }
}

/** Plays a judge that reads the heading in the preview: the section about late-delivery compensation is needed, the others can wait in the spill. */
export const headingPolicy = (block, values) => (block.preview.includes('지연 보상 정책') ? 'inject_full' : values.includes('spill_scratch') ? 'spill_scratch' : 'inject_full')

/**
 * A mock Decisions client. `policy(block) → action` plays the model; the answer is built in the real wire shape and read by the real normalizer.
 * `top` is the probability of the pick; the rest is spread over the other allowed values.
 */
export function mockDecisions(policy, { top = 0.97, latencyMs = 0, fail = null } = {}) {
  const calls = []
  return { calls, client: { async decide(request) {
    calls.push(request)
    if (fail) throw Object.assign(new Error('mock failure'), { name: 'DecisionError', code: fail })
    if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs))
    const data = request.input.at(-1).content[0].data
    const blocks = data.blocks
    const answers = request.questions.map(question => {
      const block = blocks.find(b => question.name.endsWith(`_${b.id}`))
      const values = question.choices.map(choice => choice.value)
      let pick = policy(block, values, data)
      if (!values.includes(pick)) pick = values[0]
      const rest = (1 - top) / (values.length - 1)
      const n = values.length
      return { name: question.name, type: 'choice', choice: pick, confidence: Math.max(0, (top - 1 / n) / (1 - 1 / n)),
        probabilities: values.map(value => ({ value, probability: value === pick ? top : rest })) }
    })
    return { ...normalizeDecisionResponse({ answers, model: 'gpt-6-luna' }, request.questions), latencyMs }
  } } }
}

/** What a careful judge would do with these fixtures: keep what the goal needs, collapse pure repetition, spill the rest. */
export const sensiblePolicy = (block, values, data) => {
  if (block.anchor_lines > 0 && block.lines <= 12) return 'inject_full'
  // Progress lines of a process are noise; repeated search hits or page rows are content that may be wanted later.
  if (block.repeat_ratio >= 0.6 && ['build', 'terminal'].includes(data?.tool?.kind)) return 'collapse_template'
  return values.includes('spill_scratch') ? 'spill_scratch' : 'collapse_template'
}
