// Executable design contract. No Firefox installation, credential lookup, HTTP or model call.
// A real integration must build this input from trusted host state, not from a page or package.
import { choiceQuestion, readChoice, DEFAULT_DECISION_THRESHOLDS } from './egdesk-decision-questions.mjs';
import { boardVisualNames } from './egdesk-board-visual-packet.mjs';
const names = {
  keep: '현재 배치 유지',
  overview: '선택 자료 전체 보기',
  focus: '지정 자료 한 장에 집중',
  pair: '선택한 두 장 나란히 비교',
  front: '지정 자료만 앞으로',
  ...boardVisualNames,
};
const kinds = new Set(['업무 전표', '메모', '자료', '상태표']);
const sceneEnums = {
  overlap: new Set(['none', 'selected', 'unknown']),
  frame: new Set(['inside', 'partial', 'offscreen', 'unknown']),
  clip: new Set(['inside', 'partial', 'clipped', 'unknown']),
  target: new Set(['title', 'reply', 'claim', 'manage', 'change', 'open']),
  reach: new Set(['hit', 'partial', 'miss', 'unknown']),
};
const sceneValues = Object.entries(sceneEnums);
const sceneKeys = [...Object.keys(sceneEnums), 'obscured'];
export function normalizeBoardPresentationScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) ||
      Object.keys(scene).length !== sceneKeys.length || !sceneKeys.every((key) => Object.hasOwn(scene, key)) ||
      !sceneValues.every(([key, allowed]) => allowed.has(scene[key])) || typeof scene.obscured !== 'boolean')
    return null;
  return Object.fromEntries(sceneKeys.map((key) => [key, scene[key]]));
}
const legacyQuestion = '요청의 목적에 맞는 내 화면 구성 한 가지를 고르세요. 근거가 없으면 현재 배치 유지입니다. 자료 내용 추론이나 권한 변경은 하지 마세요.';
const sceneQuestion = [
  '사용자의 요청 목적과 각 슬롯의 실측 scene을 함께 보고 내 화면 구성 한 가지를 고르세요.',
  'overlap은 선택 자료끼리의 겹침 관계입니다. 겹침만으로 가려짐을 단정하지 말고, 사용자가 의도적으로 겹친 자료는 그대로 둘 수 있습니다.',
  'frame과 clip은 각각 뷰포트와 클리핑 범위에 대한 접근 상태이고, target은 그 자료에서 확인한 한 가지 조작 대상입니다.',
  'reach는 해당 대상에서 표본으로 확인한 포인터 도달 상태이며, miss라고 픽셀이 보이지 않는다는 뜻은 아닙니다.',
  'obscured가 true인 경우만 표본에서 가려짐을 확인한 것입니다. unknown인 상태나 가림의 원인·주체를 지어내지 마세요.',
  '지정 자료만 앞으로는 지정 자료의 앞뒤 순서만 바꿉니다. 요청 목적과 측정 근거가 맞을 때만 고르고, 근거가 없으면 현재 배치 유지입니다. 자료 내용 추론이나 권한 변경은 하지 마세요.',
].join(' ');

function scenesFor(items) {
  if (!items.some((item) => Object.hasOwn(item, 'scene'))) return undefined;
  const scenes = items.map((item) => Object.hasOwn(item, 'scene') ? normalizeBoardPresentationScene(item.scene) : null);
  return scenes.every(Boolean) ? scenes : null;
}
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
  const frontEligible = (items, scenes) => {
    if (focus?.movable !== true || !scenes) return false;
    const scene = scenes[items.indexOf(focus)];
    // AABB overlap does not establish pointer obscuration. Require sampled
    // evidence and known viewport/clip access; raising cannot fix either boundary.
    return scene?.obscured === true && ['inside', 'partial'].includes(scene.frame) &&
      ['inside', 'partial'].includes(scene.clip) && ['miss', 'partial'].includes(scene.reach);
  };
  const optionsFor = (items, scenes) => [
    'keep',
    ...(items.length ? ['overview'] : []),
    ...(focus && items.includes(focus) ? ['focus'] : []),
    ...(items.length === 2 &&
    items.every((c) => c.movable === true) &&
    viewport.width >= 2 * 320 + 24 &&
    viewport.height >= 200
      ? ['pair']
      : []),
    ...(frontEligible(items, scenes) ? ['front'] : []),
  ];
  if (trigger === 'command') {
    const scenes = scenesFor(local);
    return scenes !== null && optionsFor(local, scenes).includes(explicit)
      ? outcome('local', explicit) : outcome('manual');
  }
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
  const scenes = scenesFor(selected);
  if (scenes === null) return outcome('manual');
  const options = optionsFor(selected, scenes);
  if (options.length < 2) return outcome('manual');
  const candidates = selected.map((c, i) => ({
    slot: String.fromCharCode(65 + i),
    kind: kinds.has(c.approvedKind) ? c.approvedKind : '자료',
    designatedFocus: c === focus,
    ...(scenes ? { scene: scenes[i] } : {}),
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
        scenes ? sceneQuestion : legacyQuestion,
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
