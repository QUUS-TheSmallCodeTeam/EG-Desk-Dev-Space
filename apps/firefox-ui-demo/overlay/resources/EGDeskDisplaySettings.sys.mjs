/**
 * DSN-01 / D-G4 화면·입력: the screen mode and motion the user picked in
 * Settings, and what the "데이터와 초기화" tab says about stored data.
 * Pure view model: no DOM, no prefs.
 */

export const DISPLAY_SETTINGS_PREF = 'egdesk.displaySettings.v1';
export const DISPLAY_DEFAULTS = Object.freeze({ theme: 'system', motion: 'system' });
export const CHAT_INPUT_HINT = 'Enter로 보내기 · Shift+Enter 줄바꿈';

const THEMES = Object.freeze([
  { id: 'system', label: '시스템 따라가기', note: '이 PC의 밝게·어둡게 설정을 따릅니다.' },
  { id: 'light', label: '밝게', note: '이 PC가 어두운 화면이어도 밝게 봅니다.' },
  { id: 'dark', label: '어둡게', note: '이 PC가 밝은 화면이어도 어둡게 봅니다.' },
]);
const MOTIONS = Object.freeze([
  { id: 'system', label: '시스템 따라가기', note: '이 PC의 동작 줄이기 설정을 따릅니다.' },
  { id: 'reduce', label: '항상 줄이기', note: '화면 이동과 전환을 바로 끝냅니다.' },
]);

const pick = (list, id) => list.some(item => item.id === id) ? id : 'system';

export function normalizeDisplaySettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { theme: pick(THEMES, source.theme), motion: pick(MOTIONS, source.motion) };
}

export function isDefaultDisplaySettings(raw) {
  const settings = normalizeDisplaySettings(raw);
  return settings.theme === DISPLAY_DEFAULTS.theme && settings.motion === DISPLAY_DEFAULTS.motion;
}

/** Stored text → settings. Anything unreadable follows the system. */
export function parseDisplaySettings(text) {
  if (typeof text !== 'string' || !text) return normalizeDisplaySettings(null);
  try { return normalizeDisplaySettings(JSON.parse(text)); } catch { return normalizeDisplaySettings(null); }
}

/** Text to store, or null when nothing differs from the defaults. */
export function serializeDisplaySettings(raw) {
  const settings = normalizeDisplaySettings(raw);
  return isDefaultDisplaySettings(settings) ? null : JSON.stringify(settings);
}

/** Attributes for the window root; null means "remove it". */
export function displayRootAttributes(raw) {
  const settings = normalizeDisplaySettings(raw);
  return {
    'data-egd-theme': settings.theme === 'system' ? null : settings.theme,
    'data-egd-motion': settings.motion === 'reduce' ? 'reduce' : null,
  };
}

const choices = (list, current) => list.map(item => ({ ...item, selected: item.id === current }));
export const themeChoices = raw => choices(THEMES, normalizeDisplaySettings(raw).theme);
export const motionChoices = raw => choices(MOTIONS, normalizeDisplaySettings(raw).motion);

/** Radio-group keys (APG): arrows move and wrap, Home/End jump. null = not a group key. */
export function choiceForKey(ids, currentId, key) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const index = ids.indexOf(currentId);
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  if (key === 'ArrowRight' || key === 'ArrowDown') return ids[(index + 1) % ids.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return ids[(Math.max(index, 0) - 1 + ids.length) % ids.length];
  return null;
}

export function displayResetView(raw) {
  const settings = normalizeDisplaySettings(raw);
  const label = '화면 설정 초기화';
  if (isDefaultDisplaySettings(settings)) return { disabled: true, label, note: '지금은 처음 상태입니다.' };
  const changed = [];
  if (settings.theme !== 'system') changed.push(`화면 모드: ${THEMES.find(item => item.id === settings.theme).label}`);
  if (settings.motion !== 'system') changed.push(`동작 줄이기: ${MOTIONS.find(item => item.id === settings.motion).label}`);
  return { disabled: false, label,
    note: `${changed.join(' · ')} → ${changed.length > 1 ? '둘 다 ' : ''}시스템 따라가기로 돌아갑니다.` };
}

/**
 * What EG-Desk keeps, where, and whether this tab can reset it.
 * reset: 'here' (button on this tab) | 'elsewhere' (another tab does it) | 'none'.
 */
export function dataCategories() {
  return [
    { id: 'display', title: '화면·입력', holds: '화면 모드와 동작 줄이기 선택',
      where: '이 PC의 EG-Desk 프로필', reset: 'here',
      resetNote: '아래 [화면 설정 초기화]로 되돌립니다. 다른 항목은 그대로 남습니다.' },
    { id: 'account', title: '계정 연결', holds: 'ChatGPT·Claude 로그인',
      where: '각 AI 프로그램의 로그인 보관소 (EG-Desk는 로그인 정보를 따로 보관하지 않습니다)', reset: 'elsewhere',
      resetNote: '[계정] 탭에서 연결을 확인하고 로그아웃합니다.', tab: 'account', tabLabel: '계정 탭 열기' },
    { id: 'agents', title: 'Agent 정의', holds: 'Agent 이름·맡길 일·말투와 변경 기록',
      where: '이 PC의 EG-Desk 데이터 폴더', reset: 'elsewhere',
      resetNote: '[Agent 관리] 탭에서 Agent마다 고치거나 내보냅니다. 여기서는 지우지 않습니다.', tab: 'agents', tabLabel: 'Agent 관리 탭 열기' },
    { id: 'records', title: '업무 기록', holds: 'Desk와 Board의 창 배치·메모, Chat 대화 기록',
      where: '이 PC의 EG-Desk 데이터 폴더', reset: 'none',
      resetNote: '여기서는 지우지 않습니다. 되돌릴 수 없는 삭제는 아직 제공하지 않습니다.' },
  ];
}
