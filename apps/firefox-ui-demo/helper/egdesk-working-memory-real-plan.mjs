import { createHash } from 'node:crypto'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { gateRuntimeToolResult, WM_JUDGE_MIN_TOKENS } from './egdesk-working-memory-wiring.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'

// Real-measurement plan for the working-memory gate's Decision judge (declarative format of scripts/egdesk-decision-real-measure.mjs).
// Sends nothing and reads no key. The bodies are what the PRODUCT builds: a page-reading tool result goes through the real tool-result
// boundary (gateRuntimeToolResult, flag advisory) with the judge in its content-quoting predicate design (R1/R2/R4), through the real
// Decisions client whose fetch is a recorder: it keeps the exact bytes the client would have posted and answers "keep" (0.5) to all. The judge is advisory only in the product; this plan measures whether it would be right.
// Public synthetic Korean text only (meeting minutes of a fictional team). One document, two requests: the same blocks are judged
// against a narrow goal and against a broad one, so the answers must move with the goal if the judge reads the content (paired design).
// Two requests is all the ceiling allows: the judge only runs at >= WM_JUDGE_MIN_TOKENS (2,750) of open text per tool result.
export const WM_PLAN_SET = 'working-memory-judge-v1'
export const WM_PLAN_TOKEN_CEILING = 8000
export const WM_PLAN_DIR = 'proofs/decision-real-measure/working-memory-judge'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const MINUTES = [
  ['참석자', ['이번 회의에는 결제팀 박서윤, 정민호와 운영팀 한지우가 참석했다.', '디자인팀 오세린은 오후 일정 때문에 앞의 30분만 함께했다.', '외부 협력사 담당자는 이번에는 초대하지 않았다.', '회의는 본사 3층 작은 회의실에서 오전 10시에 시작했다.', '회의록은 정민호가 쓰고 다음 날 아침에 공유하기로 했다.', '불참한 품질팀에는 결정 사항만 따로 전달하기로 했다.', '회의 진행은 운영팀 한지우가 맡았다.']],
  ['지난 회의 확인 사항', ['지난주에 맡았던 결제 오류 로그 정리는 박서윤이 끝냈다고 보고했다.', '테스트 서버 증설은 아직 예산 승인을 기다리는 중이라고 했다.', '고객 문의 분류 기준표는 한지우가 초안을 만들어 왔다.', '지난번에 미룬 보안 점검 일정은 이번 달 말로 다시 잡혔다.', '협력사 계약 갱신 건은 법무 검토가 끝나야 진행할 수 있다고 했다.', '나머지 항목은 모두 끝난 것으로 확인했다.', '확인 사항 정리는 회의 시작 후 10분 안에 끝냈다.']],
  ['결제 모듈 배포 일정', ['새 결제 모듈의 운영 배포일은 12월 9일 화요일 오전 10시로 확정했다.', '배포 전날인 12월 8일 오후에 최종 리허설을 한 번 더 하기로 했다.', '배포 뒤 한 시간 동안 결제 오류율이 2%를 넘으면 바로 되돌리기로 정했다.', '되돌릴지 말지는 정민호가 판단하고 결과를 운영팀에 알린다.', '배포 당일에는 고객센터 인원을 두 명 더 배치하기로 했다.', '배포 공지는 12월 5일에 홈페이지와 앱에 동시에 올린다.', '배포 작업에는 결제팀 두 명과 운영팀 한 명이 붙는다.']],
  ['고객센터 안내 문구 개편', ['결제 실패 때 보이는 안내 문구가 너무 어렵다는 의견이 많았다.', '한지우가 쉬운 말로 바꾼 문구 열두 개를 다음 회의까지 준비한다.', '문구마다 고객이 다음에 할 일을 한 줄로 적기로 했다.', '영어 문구는 이번에는 바꾸지 않고 한국어만 먼저 손본다.', '바뀐 문구는 내부 시험 기간 2주 동안 반응을 보고 확정한다.', '문구 길이는 휴대전화 화면에서 두 줄을 넘지 않게 한다.', '고객센터 상담원 다섯 명에게 바뀐 문구를 먼저 보여 주기로 했다.']],
  ['디자인 시안 피드백', ['오세린이 결제 완료 화면 시안 세 가지를 보여 주었다.', '참석자 대부분이 두 번째 시안의 색 대비가 가장 읽기 쉽다고 했다.', '버튼 위치는 엄지로 누르기 쉬운 아래쪽으로 옮겨 달라고 요청했다.', '아이콘은 기존 것을 그대로 쓰고 새로 만들지 않기로 했다.', '수정한 시안은 다음 주 수요일까지 받기로 했다.', '시안 파일은 팀 공유 폴더의 디자인 항목에 올라가 있다.', '접근성 검토는 시안이 확정된 뒤에 따로 받는다.']],
  ['예산 집행 현황', ['올해 결제팀 예산은 지금까지 71%를 썼다고 보고했다.', '남은 예산은 테스트 장비와 외부 점검 비용에 먼저 쓰기로 했다.', '출장비는 분기마다 한도를 다시 보기로 했다.', '소프트웨어 구독 두 개는 쓰는 사람이 없어 해지한다.', '예산 보고서는 한지우가 월말에 정리한다.', '추가 예산 요청은 내년 계획에 넣기로 했다.', '법인 카드 사용 내역은 매주 금요일에 맞춰 본다.']],
  ['보안 점검', ['외부 보안 점검은 이번 달 마지막 주에 사흘 동안 받는다.', '점검 기간에는 운영 서버 설정을 바꾸지 않기로 했다.', '지난 점검에서 나온 지적 사항 네 개 가운데 세 개는 고쳤다.', '남은 한 개는 로그 보관 기간 문제로 운영팀과 함께 본다.', '점검 결과 보고서는 받는 대로 팀 전체에 공유한다.', '점검 담당 연락처는 박서윤이 협력사에 전달했다.', '점검 첫날 아침에 운영팀과 짧게 준비 회의를 한다.']],
  ['채용', ['결제팀 개발자 한 명을 더 뽑는 공고가 지난주에 올라갔다.', '지원자는 지금까지 열일곱 명이고 서류 검토가 진행 중이다.', '면접은 정민호와 박서윤이 함께 보기로 했다.', '과제 전형은 이번에는 하지 않고 대면 면접만 한다.', '합격자는 내년 1월 초에 합류하는 것을 목표로 한다.', '채용 일정은 인사팀 사정에 따라 바뀔 수 있다.', '면접 질문 목록은 지난 채용 때 쓴 것을 고쳐 쓴다.']],
  ['교육과 공유', ['다음 달 사내 기술 공유회에서 결제팀이 장애 대응 사례를 발표한다.', '발표 자료는 정민호가 만들고 박서윤이 검토한다.', '새로 온 운영팀 직원을 위한 결제 흐름 교육을 한 번 열기로 했다.', '교육 자료는 지난해 자료를 고쳐서 쓴다.', '공유회 녹화본은 사내 게시판에 올린다.', '외부 세미나 참가 신청은 팀장 승인을 받아야 한다.', '교육 날짜는 운영팀 일정을 받아 본 뒤에 정한다.']],
  ['기타', ['회의 끝에 연말 송년회 장소를 두고 잠깐 이야기가 오갔다.', '점심은 회사 앞 국숫집에서 다 같이 먹자는 의견이 나왔다.', '주차장 공사 때문에 다음 주에는 대중교통을 이용해 달라는 공지가 있었다.', '사무실 커피 머신이 고장 나서 수리를 맡겼다고 한다.', '이번 주 금요일은 오후 4시에 일찍 퇴근하는 날이다.', '특별히 정한 것은 없고 가벼운 이야기로 마무리했다.', '다음 주 월요일에는 건물 소방 점검이 있다는 안내도 있었다.']],
  ['다음 회의', ['다음 회의는 12월 2일 화요일 오전 10시에 같은 장소에서 한다.', '안건은 배포 리허설 준비 상황과 안내 문구 초안 검토다.', '각자 맡은 일의 진행 상황을 한 줄씩 미리 공유하기로 했다.', '회의 시간은 40분을 넘기지 않기로 했다.', '외부 협력사는 이번에도 부르지 않는다.', '회의록 담당은 이번에는 박서윤이다.', '참석이 어려운 사람은 하루 전까지 알려 주기로 했다.']],
]
const page = (title, sections, footer) => [title, '', ...sections.flatMap(([heading, lines], i) => [`## ${heading}`, ...lines, ...(i < sections.length - 1 ? [''] : [])]), '', ...footer].join('\n')
const MINUTES_TEXT = page('결제팀 주간 회의록 (공개용 합성 예시)', MINUTES, ['작성: 정민호', '배포: 결제팀, 운영팀'])

// Pre-registered BEFORE any body was built: for each case, what each section is for the person's request.
//   needed: the answer is in it. near: it shares a word with the request but does not answer it. unrelated: neither.
export const WM_CASES = Object.freeze([
  { id: 'minutes-deploy-decision', text: MINUTES_TEXT, goal: '회의록에서 결제 모듈 배포 일정에 대해 정해진 것만 알려 줘',
    roles: { '결제 모듈 배포 일정': 'needed', '다음 회의': 'near', '지난 회의 확인 사항': 'near' }, otherwise: 'unrelated',
    why: 'Every decision about the deployment is in 결제 모듈 배포 일정. 다음 회의 mentions the rehearsal only as an agenda item and 지난 회의 확인 사항 mentions test servers; neither decides anything about the deployment date.' },
  { id: 'minutes-summarise-all', text: MINUTES_TEXT, goal: '이 회의록 전체를 빠짐없이 요약해 줘', roles: {}, otherwise: 'needed',
    why: 'Control: a full summary needs every section. A judge that drops sections here would drop material whenever the request is broad.' },
])

const egress = createEgressGate(modelDataPermissions({ browserGranted: true, runActive: true }))
const provider = { workingMemory: { egdesk_page_read: { kind: 'page' } } }
function captureClient(sink) {
  return createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0003', fetchImpl: async (url, init) => {
    sink.push({ url: String(url), bytes: Buffer.from(init.body, 'utf8') })
    const body = JSON.parse(init.body)
    return Response.json({ model: DECISION_MODEL, answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.5 })) })
  } })
}
const sectionOf = (body, id) => {
  const quoted = body.input.at(-1).content
  const block = new RegExp(`Block ${id} \\(lines [^)]*\\):\\n"""\\n([\\s\\S]*?)\\n"""`).exec(quoted)?.[1] ?? ''
  return [...block.matchAll(/^## (.+)$/gm)].map(m => m[1])
}
// The product cuts blocks by its own rules, so one block can hold two sections. A block's role is the strongest role among its sections.
const RANK = { needed: 3, near: 2, unrelated: 1 }
const blockRole = (c, sections) => sections.map(name => c.roles[name] ?? c.otherwise).sort((a, b) => RANK[b] - RANK[a])[0]

/** Build the plan with the product code. Returns { plan, planBytes, requests: [{ id, file, bytes, body }] }. */
export async function buildWorkingMemoryPlan() {
  const requests = [], planRequests = []
  for (const c of WM_CASES) {
    const sink = []
    const response = { success: true, contentItems: [{ type: 'inputText', text: c.text }] }
    const result = await gateRuntimeToolResult({ response, flag: 'advisory', provider, tool: 'egdesk_page_read', engineId: 'codex', goal: c.goal, egress,
      decision: { mode: () => 'advisory', configured: () => true, client: captureClient(sink), judgeDesign: 'predicates' } })
    if (result.response !== response) throw new Error(`${c.id}: advisory changed the tool result`)
    await result.judge
    if (sink.length !== 1) throw new Error(`${c.id}: the judge was not asked exactly once (asked ${sink.length}); the text may be under ${WM_JUDGE_MIN_TOKENS} tokens left by the rules`)
    const bytes = sink[0].bytes, body = JSON.parse(bytes.toString('utf8')), questions = body.questions
    if (sink[0].url !== 'https://api.openai.com/v1/decisions') throw new Error(`${c.id}: the client posted to ${sink[0].url}`)
    const expect = []
    for (const q of questions) {
      const id = q.name.replace('wm_need_', ''), sections = sectionOf(body, id), section = sections.join(' + ')
      if (!sections.length) throw new Error(`${c.id}: block ${id} carries no section heading`)
      const role = blockRole(c, sections)
      if (role === 'needed') expect.push(
        { name: q.name, kind: 'predicate', min: 0.21, severity: 'hard', note: `${section}: needed for the request. Hard: it must not be decided "not needed" (<= 0.2), because the code would then take it out of the model's context.` },
        { name: q.name, kind: 'predicate', min: 0.8, severity: 'soft', note: `${section}: decided needed (>= 0.8), so it stays verbatim.` })
      else if (role === 'unrelated') expect.push(
        { name: q.name, kind: 'predicate', max: 0.79, severity: 'hard', note: `${section}: unrelated to the request. Hard: not decided "needed"; a judge that keeps everything saves nothing.` },
        { name: q.name, kind: 'predicate', max: 0.2, severity: 'soft', note: `${section}: decided not needed (<= 0.2), so the code spills it behind a pointer.` })
      else expect.push({ name: q.name, kind: 'predicate', max: 0.79, severity: 'soft', note: `${section}: shares words with the request but does not answer it (near miss). Soft: not decided needed.` })
    }
    const file = `requests/${c.id}.json`
    requests.push({ id: c.id, file, bytes, body })
    planRequests.push({ id: c.id, file, sha256: sha(bytes), estInputTokens: independentEstimate(0, questions.length, bytes.length), expect })
  }
  const plan = { set: WM_PLAN_SET, tokenCeiling: WM_PLAN_TOKEN_CEILING,
    passRule: 'A request passes when no hard check fails: no needed block is decided "not needed" (p <= 0.2) and no unrelated block is decided "needed" (p >= 0.8). ' +
      'Soft checks: needed blocks decided needed (>= 0.8), unrelated blocks decided not needed (<= 0.2), near misses not decided needed. The set passes when both requests pass. ' +
      'Bars are the gate\'s own: yes >= 0.8 keeps a block, no <= 0.2 lets the code spill it, anything between keeps it. Bodies are built by the product (advisory judge, predicate design).',
    requests: planRequests }
  const total = planRequests.reduce((sum, r) => sum + r.estInputTokens, 0)
  if (total > WM_PLAN_TOKEN_CEILING) throw new Error(`the plan estimates ${total} input tokens, over the ceiling of ${WM_PLAN_TOKEN_CEILING}`)
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), requests, totals: { requests: requests.length, estInputTokens: total } }
}
