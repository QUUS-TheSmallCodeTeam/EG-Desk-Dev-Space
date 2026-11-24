// L4 cycle 28: the person's REAL requests (lane L3's masked conversation examples, owner-approved) paired with briefing material BY CODE. Pure: rows in, rows out.
// - briefingRequestKind(text): 'summary' (summarise / compare / show progress / "정리해줘") | 'one_fact' (a short question asking when / how many / how much) | null
// - sameWindowPairs(requests, pages): a request is paired only with material dated on the request's own day (the record of that time); none -> dropped, said so
// - replayable(text): the wording names no subject of its own (every word is generic summary/progress vocabulary), so it can be asked over another day's record
//   without implying a context it does not have ("최신 업데이트 내역 정리해봐줘" yes; "swarm 시스템은 어디까지 동작하는거지?" no)
// cycle 29: '요약본' (a summary COPY, a noun) is not a request to summarise
const SUMMARY = /정리(?:해|좀|해줘|해봐|해 ?줘|해주)|요약(?!본)|비교|진행 ?상황|현황|뭐가 바뀌|무엇이 바뀌|바뀐 ?(?:점|것)|변경 ?(?:사항|내역)|업데이트 ?내역|어디까지|진척|status|summar|compare|progress/i
// imperatives that are not a briefing request even when a summary word occurs ("푸시해줘", "삭제…정리해줘" are actions on files)
const ACTION = /푸시|push|삭제|지워|커밋해|다듬어|반영해|올려|설치|저장해|확인해서/i
const ONE_FACT = /(?:언제|몇\s?(?:개|번|시|건|명|%)?|얼마|어디서|어디에|누가)/
export function briefingRequestKind(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 400 || t.includes('```')) return null
  if (SUMMARY.test(t) && !ACTION.test(t)) return 'summary'
  if (t.length <= 80 && /\?\s*$/.test(t) && ONE_FACT.test(t) && !SUMMARY.test(t)) return 'one_fact'
  return null
}
const day = at => (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null)
/** -> [{ request, pages: [...same-day pages], dropped: null | 'no-material-in-window' }] */
export function sameWindowPairs(requests, pages) {
  return requests.map(r => {
    const d = day(r.at), same = d ? pages.filter(p => p.time?.at === d) : []
    return { request: r, pages: same, dropped: same.length ? null : 'no-material-in-window' }
  })
}
// generic words of a summary / progress request (word stems; a token matches when it starts with one); everything else is a subject the request names
const GENERIC = ['최신', '업데이트', '내역', '정리', '요약', '오케이', '그래서', '뭘', '뭐', '무엇', '작업', '이때까지', '지금까지', '그동안', '진행', '상황', '현황', '좀', '해봐', '해줘', '줘', '한번', '전체', '요즘', '오늘']
const tokens = t => String(t).replace(/[?!.,~…·"'`()\[\]]/g, ' ').split(/\s+/).filter(Boolean)
export function replayable(text) {
  const ts = tokens(text)
  return ts.length > 0 && ts.every(tok => GENERIC.some(g => tok.startsWith(g)))
}
