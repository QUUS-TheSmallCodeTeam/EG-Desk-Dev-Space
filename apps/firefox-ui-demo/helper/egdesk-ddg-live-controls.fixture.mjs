// a2 (L8b, real window 2026-11-26 17:27 KST): the controls of the DuckDuckGo Card as observed (80 elements; role and name only, values masked:
// $L/evidence/a1-live/ddg-home-controls.json). The page is a results page for the query (its tabs, filters and ten results), not the home page.
// What the dump does not keep is rebuilt by rule (ddgResultsSnapshot below): tags by role, same-site DuckDuckGo addresses for its tabs and its "… 도메인 검색" links,
// the result sites for the result links, the query in the search box, and the read-only GET form of the 검색 button.
export const DDG_LIVE_ROWS = Object.freeze([
  ["1", "link", "DuckDuckGo home"],
  ["2", "clickable", "react-search-form"],
  ["3", "combobox", "개인 정보 노출 없이 검색"],
  ["4", "button", "검색"],
  ["5", "clickable", "모두 이미지 동영상 뉴스 지도 Duck.ai 검색 설정"],
  ["6", "link", "모두"],
  ["7", "link", "이미지"],
  ["8", "link", "동영상"],
  ["9", "link", "뉴스"],
  ["10", "link", "지도"],
  ["11", "span", "Duck.ai"],
  ["12", "link", "Duck.ai"],
  ["13", "span", "검색 설정"],
  ["14", "button", "검색 설정"],
  ["15", "clickable", "아무도 모르게 대한민국 안전 검색: 보통 모든 날짜 namu.wiki https://namu.wiki › w"],
  ["16", "button", "아무도 모르게"],
  ["17", "clickable", ""],
  ["18", "clickable", ""],
  ["19", "switch", "선택한 지역으로 필터링하기"],
  ["20", "button", "대한민국"],
  ["21", "button", "안전 검색: 보통"],
  ["22", "button", "모든 날짜"],
  ["23", "clickable", "namu.wiki https://namu.wiki › w › 장화 신은 고양이 장화 신은 고양이 - 나무위키"],
  ["24", "button", ""],
  ["25", "link", "namu.wiki 도메인 검색"],
  ["26", "link", "https://namu.wiki › w › 장화 신은 고양이"],
  ["27", "link", "장화 신은 고양이 - 나무위키"],
  ["28", "clickable", "namu.wiki https://namu.wiki › w › 장화신은 고양이: 끝내주는 모험 장화신은 고양이"],
  ["29", "button", ""],
  ["30", "link", "namu.wiki 도메인 검색"],
  ["31", "link", "https://namu.wiki › w › 장화신은 고양이: 끝내주는 모험"],
  ["32", "link", "장화신은 고양이: 끝내주는 모험 - 나무위키"],
  ["33", "clickable", "Netflix https://www.netflix.com › kr › title › 70202053 Watc"],
  ["34", "button", ""],
  ["35", "link", "netflix.com 도메인 검색"],
  ["36", "link", "https://www.netflix.com › kr › title › 70202053"],
  ["37", "link", "Watch 장화신은 고양이 | Netflix"],
  ["38", "clickable", "YouTube https://www.youtube.com › watch?v=qQ-_MmnKF4A 씹지도 않고"],
  ["39", "button", ""],
  ["40", "link", "youtube.com 도메인 검색"],
  ["41", "link", "https://www.youtube.com › watch?v=qQ-_MmnKF4A"],
  ["42", "link", "씹지도 않고 거인을 꿀꺽 | 토시가 되기 싫어 장화를 신은 고양이"],
  ["43", "clickable", "YouTube https://www.youtube.com › watch?v=5aHEFEJby3s 장화 신은 "],
  ["44", "button", ""],
  ["45", "link", "youtube.com 도메인 검색"],
  ["46", "link", "https://www.youtube.com › watch?v=5aHEFEJby3s"],
  ["47", "link", "장화 신은 고양이 - 동화 - 만화 - 한국 어린이 이야기 - 동화 속의 ..."],
  ["48", "clickable", "네이버 블로그 https://blog.naver.com › popcorn_view › 224461883366"],
  ["49", "button", ""],
  ["50", "link", "blog.naver.com 도메인 검색"],
  ["51", "link", "https://blog.naver.com › popcorn_view › 224461883366"],
  ["52", "link", "장화신은 고양이: 끝내주는 모험 영화 줄거리·출연진·후기 ..."],
  ["53", "clickable", "Netflix https://www2.stage.netflix.com › kr › title › 815557"],
  ["54", "button", ""],
  ["55", "link", "www2.stage.netflix.com 도메인 검색"],
  ["56", "link", "https://www2.stage.netflix.com › kr › title › 81555726"],
  ["57", "link", "Watch 장화 신은 고양이: 끝내주는 모험 | Netflix"],
  ["58", "clickable", "네이버 블로그 https://blog.naver.com › brlim02 › 224450492854 장화신은"],
  ["59", "button", ""],
  ["60", "link", "blog.naver.com 도메인 검색"],
  ["61", "link", "https://blog.naver.com › brlim02 › 224450492854"],
  ["62", "link", "장화신은 고양이 영화 애니 줄거리, Ott, 캐릭터, 성우 : 네이버 ..."],
  ["63", "clickable", "storydesign18.tistory.com https://storydesign18.tistory.com "],
  ["64", "button", ""],
  ["65", "link", "storydesign18.tistory.com 도메인 검색"],
  ["66", "link", "https://storydesign18.tistory.com › entry › 장화-신은-고양이-소개-및-줄"],
  ["67", "link", "장화 신은 고양이 소개 및 줄거리,결론 그리고 만약에"],
  ["68", "clickable", "리디 https://ridibooks.com › books › 805023545 장화 신은 고양이 [샤를 페"],
  ["69", "button", ""],
  ["70", "link", "ridibooks.com 도메인 검색"],
  ["71", "link", "https://ridibooks.com › books › 805023545"],
  ["72", "link", "장화 신은 고양이 [샤를 페로] : 100년, 뿌리 깊은 고전문학 시리즈"],
  ["73", "link", "장화 신은 고양이에 대한 이미지"],
  ["74", "button", "AI 이미지: 보기"],
  ["75", "link", "장화신은 고양이 어린시절 최초공개, 애교만점 눈망울은 새끼때부터 … | bnt뉴스"],
  ["76", "link", "장화신은 고양이 어린시절 최초공개, 애교만점 눈망울은 새끼때부터 … | bnt뉴스 bntnews.co.kr"],
  ["77", "clickable", ""],
  ["78", "button", "메뉴"],
  ["79", "link", "장화신은 고양이: 끝내주는 모험 - Movies on Google Play"],
  ["80", "link", "장화신은 고양이: 끝내주는 모험 - Movies on Google Play play.google.com"],
].map(Object.freeze))
const D = "https://duckduckgo.com"
const TAB = { 모두: "web", 이미지: "images", 동영상: "videos", 뉴스: "news", 지도: "maps", "Duck.ai": "chat" }
const TAG = { link: "a", button: "button", combobox: "input", clickable: "div", switch: "button", span: "span" }
const urlFromName = name => { const m = /^(https:\/\/[^ ›]+)((?: › [^›]+)*)/.exec(name); return m ? m[1] + m[2].split(" › ").map(s => s.trim()).filter(Boolean).map(s => "/" + encodeURIComponent(s)).join("") : null }
/** ddgResultsSnapshot({ query?, value? }) -> a snapshot like the Card's at 17:27 (the controls of the dump, the addresses rebuilt by rule). */
export function ddgResultsSnapshot({ query = "장화 신은 고양이", value = query, revision = 1 } = {}) {
  const q = encodeURIComponent(query)
  let site = null
  const elements = DDG_LIVE_ROWS.map(([n, role, name]) => {
    const element = { ref: "el_" + n, role, tag: TAG[role] ?? "div", label: name, href: "", value: "", disabled: false }
    if (role === "combobox") element.value = value
    if (role === "link") {
      const own = urlFromName(name)
      if (own) site = own
      element.href = name === "DuckDuckGo home" ? D + "/" : TAB[name] ? D + "/?q=" + q + "&ia=" + TAB[name]
        : /도메인 검색$/.test(name) ? D + "/?q=" + q + "+site%3A" + encodeURIComponent(name.replace(/ 도메인 검색$/, "")) + "&ia=web"
        : /에 대한 이미지$/.test(name) ? D + "/?q=" + q + "&iax=images&ia=images"
        : /bntnews|bnt뉴스/.test(name) ? "https://www.bntnews.co.kr/article/view/bnt202211220001"
        : /Google Play/.test(name) ? "https://play.google.com/store/movies/details?id=x"
        : own ?? site ?? D + "/"
    }
    if (role === "button" && name === "검색") element.nav = { type: "submit", sensitiveRegion: false, regionLabel: "", form: { method: "get", fields: ["text", "hidden", "submit"], sensitive: false, submitUrl: D + "/?q=" + encodeURIComponent(value) }, controls: null }
    else if (role === "button") element.nav = { type: "button", sensitiveRegion: false, regionLabel: "", form: null, controls: null }
    return element
  })
  return { url: D + "/?q=" + q + "&ia=web", documentId: "d" + revision, revision, readyState: "complete", title: query + " at DuckDuckGo", text: [query, "장화 신은 고양이 - 나무위키"], interactiveElements: elements, scroll: { x: 0, y: 0, maxY: 2400 } }
}
