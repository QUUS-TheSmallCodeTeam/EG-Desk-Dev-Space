// Executable design contract. No Firefox installation, credential lookup, HTTP or model call.
// A real integration must build this input from trusted host state, not from a page or package.
import { choiceQuestion, readChoice, DEFAULT_DECISION_THRESHOLDS } from './egdesk-decision-questions.mjs';
const names = {
  keep: '현재 배치 유지',
  overview: '선택 자료 전체 보기',
  focus: '지정 자료 한 장에 집중',
  pair: '선택한 두 장 나란히 비교',
};
const kinds = new Set(['업무 전표', '메모', '자료', '상태표']);
export function prepareBoardPresentation({
  mode = 'off',
  trigger = 'suggest',
  explicit = null,
  requestText = '',
  selection = [],
  viewport = {},
  authority = {},
  binding = '',
  focusId = null,
} = {}) {
  const outcome = (status, plan = 'keep') => ({ status, plan, packet: null });
  if (!binding || !['off', 'advisory', 'on'].includes(mode)) return outcome('manual');
  const local = selection.filter((c) => c.renderable === true && c.canRead === true);
  const focus = local.find((c) => c.id === focusId);
  // An imperative from a direct UI control names the choice. Do not guess that free text is an imperative.
  const optionsFor = (items) => [
    'keep',
    ...(items.length ? ['overview'] : []),
    ...(focus && items.includes(focus) ? ['focus'] : []),
    ...(items.length === 2 &&
    items.every((c) => c.movable === true) &&
    viewport.width >= 2 * 320 + 24 &&
    viewport.height >= 200
      ? ['pair']
      : []),
  ];
  if (trigger === 'command')
    return optionsFor(local).includes(explicit) ? outcome('local', explicit) : outcome('manual');
  if (
    trigger !== 'suggest' ||
    mode === 'off' ||
    authority.revision !== binding ||
    authority.approved !== true ||
    authority.reviewedCue !== requestText ||
    typeof requestText !== 'string' ||
    !requestText.trim() ||
    requestText.length > 280
  )
    return outcome('manual');
  // Do not even use an ineligible card to generate a choice, a count, or a slot. Slots have no global identity.
  const selected = local.filter((c) => c.maySendDescriptor === true).slice(0, 12);
  const options = optionsFor(selected);
  if (options.length < 2) return outcome('manual');
  const candidates = selected.map((c, i) => ({
    slot: String.fromCharCode(65 + i),
    kind: kinds.has(c.approvedKind) ? c.approvedKind : '자료',
    designatedFocus: c === focus,
  }));
  const packet = {
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: requestText },
          {
            type: 'input_json',
            data: { selected: candidates, availableWidth: viewport.width >= 664 ? '두 장 폭' : '한 장 폭' },
          },
        ],
      },
    ],
    questions: [
      choiceQuestion(
        'board_view',
        '요청의 목적에 맞는 내 화면 구성 한 가지를 고르세요. 근거가 없으면 현재 배치 유지입니다. 자료 내용 추론이나 권한 변경은 하지 마세요.',
        options.map((k) => ({ value: names[k] })),
      ),
    ],
  };
  return { status: 'prepared', mode, binding, options, packet };
}
// Local enum only. Neither the receipt nor the external answer is a write command.
export function readBoardPresentation(prepared, answers, currentBinding) {
  const base = { status: 'manual', preview: null, reasoningCalls: 0 };
  if (prepared?.status !== 'prepared' || currentBinding !== prepared.binding) return base;
  const a = answers?.board_view;
  if (
    a?.type !== 'choice' ||
    !Array.isArray(a.probabilities) ||
    a.probabilities.length < 2 ||
    !Number.isFinite(a.confidence) ||
    a.confidence < 0 ||
    a.confidence > 1 ||
    a.probabilities[0]?.value !== a.choice ||
    new Set(a.probabilities.map((p) => p.value)).size !== a.probabilities.length ||
    !a.probabilities.every(
      (p, i) =>
        p &&
        Number.isFinite(p.probability) &&
        p.probability >= 0 &&
        p.probability <= 1 &&
        (!i || p.probability <= a.probabilities[i - 1].probability) &&
        prepared.options.some((k) => names[k] === p.value),
    )
  )
    return base;
  const r = readChoice(answers, 'board_view', {
    minConfidence: DEFAULT_DECISION_THRESHOLDS.choice,
    minMargin: DEFAULT_DECISION_THRESHOLDS.margin,
  });
  const k = prepared.options.find((key) => names[key] === r.value);
  if (r.state !== 'accepted' || !k) return base;
  return prepared.mode === 'advisory'
    ? { status: 'advisory-only', suggestion: k, preview: null, reasoningCalls: 0 }
    : { status: 'preview', preview: k, reasoningCalls: 0 };
}
