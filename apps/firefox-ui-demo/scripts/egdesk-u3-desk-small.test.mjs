import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { NO_FOLDER_MESSAGE, NO_FOLDER_HINT, noFolderBody } from '../helper/egdesk-no-folder.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

// ---- D10: the refusal carries the person's sentence ----
test('u3/D10: noFolderBody keeps status and code and adds the existing sentence and a closed hint; the sentence is the first sentence of the screen\'s own text', () => {
  assert.deepEqual(noFolderBody('FILE_NO_FOLDER'), { status: 'no_folder', code: 'FILE_NO_FOLDER', message: '연결된 프로젝트 폴더가 없습니다.', hint: { needs: 'project_folder' } })
  assert.equal(Object.isFrozen(NO_FOLDER_HINT), true)
  assert.match(surface, new RegExp(`CHAT_REQUEST_PROJECT_CONNECT = '${NO_FOLDER_MESSAGE.replace('.', '\\.')} `), 'no new copy: the words are the screen\'s existing ones')
  for (const file of ['egdesk-file-tools.mjs', 'egdesk-command-executor.mjs']) {
    const text = readFileSync(new URL(`../helper/${file}`, import.meta.url), 'utf8')
    assert.match(text, /import \{ noFolderBody \} from '\.\/egdesk-no-folder\.mjs'/); assert.match(text, /respond\(true, noFolderBody\('(FILE|COMMAND)_NO_FOLDER'\)\)/)
    assert.doesNotMatch(text, /status: 'no_folder', code: '(FILE|COMMAND)_NO_FOLDER' \}/, 'no bare code-only refusal left')
  }
})

// ---- D11: default room numbers are unique across engines and restarts ----
test('u3/D11: nextDefaultRoomNumber is one above every default-named room (any engine) and never below the counter; chosen names do not count', () => {
  const rooms = titles => titles.map((title, i) => ({ id: `t${i}`, title }))
  assert.equal(ChatState.nextDefaultRoomNumber([], 0), 1)
  assert.equal(ChatState.nextDefaultRoomNumber(rooms(['Claude 1']), 0), 2, 'after a restart the counter is 0: the new room is not "Claude 1" again')
  assert.equal(ChatState.nextDefaultRoomNumber(rooms(['Codex 1', 'Claude 3', 'Codex 2']), 0), 4)
  assert.equal(ChatState.nextDefaultRoomNumber(rooms(['Claude 1']), 7), 8, 'never below the counter')
  assert.equal(ChatState.nextDefaultRoomNumber(rooms(['견적 검토', 'Claude 1 메모', 'Codex', 'Claude 12x']), 0), 1, 'names the person chose, and unnumbered names, do not count')
  assert.equal(ChatState.nextDefaultRoomNumber(null, NaN), 1); assert.equal(ChatState.nextDefaultRoomNumber([{ title: 5 }, null], 2), 3)
})

test('u3/D11: switching a room to another engine never takes a name another room has; a free name keeps its number', () => {
  const room = { id: 'a', type: 'dm', title: 'Codex 2', participants: ['나', 'Codex'] }
  const taken = [room, { id: 'b', type: 'dm', title: 'Claude 2' }, { id: 'c', type: 'dm', title: 'Claude 5' }]
  assert.equal(ChatState.relabelDefaultRoom(room, 'Claude', '나', { threads: taken }).title, 'Claude 6', 'Claude 2 exists: the next free number')
  assert.equal(ChatState.relabelDefaultRoom(room, 'Claude', '나', { threads: [room] }).title, 'Claude 2', 'free: the number is kept')
  assert.equal(ChatState.relabelDefaultRoom(room, 'Claude').title, 'Claude 2', 'without the list: as before')
  assert.match(surface, /ChatState\.relabelDefaultRoom\(thread, engineLabel, SELF_MEMBER, \{ threads: state\.codex\.threads \}\)/)
  assert.match(surface, /const nextNonce = normalizedType === 'group' \|\| typeof ChatState === 'undefined' \|\| !ChatState\.nextDefaultRoomNumber \? state\.codex\.threadNonce \+ 1 : ChatState\.nextDefaultRoomNumber\(state\.codex\.threads, state\.codex\.threadNonce\);/)
})

// ---- D13: the list preview is the last message with words ----
function previewFn() {
  const src = surface.match(/  function codexThreadPreview\(thread\) \{[\s\S]*?\n  \}/)[0]
  return runInNewContext(`${src}\ncodexThreadPreview`, { codexThreadKindMeta: type => ({ emptyPreview: type === 'group' ? '아직 Board 메시지가 없습니다' : '아직 메시지가 없습니다' }),
    ChatState: { awaitResumeMessageView: () => null } })
}
test('u3/D13: a room whose last message has no words previews the last message that has; a room with no words at all keeps the empty line', () => {
  const preview = previewFn()
  const msgs = [{ role: 'user', content: '파일 목록 보여줘' }, { role: 'assistant', content: '프로젝트 폴더가 없습니다' }, { role: 'assistant', content: '' }]
  assert.equal(preview({ type: 'dm', messages: msgs }), '프로젝트 폴더가 없습니다')
  assert.equal(preview({ type: 'dm', messages: [{ role: 'user', content: '질문' }, { role: 'assistant' }] }), '나: 질문')
  assert.equal(preview({ type: 'dm', messages: [{ role: 'assistant', content: '' }] }), '아직 메시지가 없습니다')
  assert.equal(preview({ type: 'group', messages: [] }), '아직 Board 메시지가 없습니다'); assert.equal(preview({ type: 'dm' }), '아직 메시지가 없습니다')
  assert.equal(preview({ type: 'dm', messages: [{ role: 'user', content: 'a'.repeat(100) }] }).length, 70 )
  assert.match(surface, /const lastMsg = \(Array\.isArray\(thread\.messages\) \? thread\.messages : \[\]\)\.findLast\(message => message && message\.content\) \|\| null;/)
})
