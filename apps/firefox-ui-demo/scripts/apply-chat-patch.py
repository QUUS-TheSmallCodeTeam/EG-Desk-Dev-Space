#!/usr/bin/env python3
"""EGDesk Chat UI Phase 1 개선 패치 적용 스크립트
변경 사항:
1. 아바타 색상/이니셜 유틸 함수 추가
2. 시간 포맷 유틸 함수 추가
3. 채팅방 목록에 아바타 + 시간 표시
4. 메시지 버블에 타임스탬프 + 그룹핑
"""
import os
import re

PROFILE = os.path.expanduser(
    "~/Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release"
)
JS_FILE = os.path.join(PROFILE, "chrome/JS/eg-desk-surface.uc.js")
CSS_FILE = os.path.join(PROFILE, "chrome/CSS/eg-desk-surface.uc.css")

# Read files
with open(JS_FILE, "r", encoding="utf-8") as f:
    js = f.read()
with open(CSS_FILE, "r", encoding="utf-8") as f:
    css = f.read()

# ============================================================
# PATCH 1: 유틸 함수 추가 (SELF_MEMBER 뒤에)
# ============================================================
UTIL_FUNCTIONS = """
  const AVATAR_COLORS = [
    '#2D5A7B', '#6B4C8A', '#2F6F45', '#8C5E2C', '#7B2D5A',
    '#3D6B6B', '#5A4B82', '#6B7B2D', '#825A3D', '#2D6B5A',
  ];
  function getAvatarColor(name) {
    if (!name) return AVATAR_COLORS[0];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
  function getAvatarInitial(name) {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  }
  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return minutes + '분 전';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + '시간 전';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + '일 전';
    const date = new Date(timestamp);
    return (date.getMonth() + 1) + '/' + date.getDate();
  }
  function formatMessageTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    const period = h < 12 ? '오전' : '오후';
    const hour12 = h % 12 || 12;
    return period + ' ' + hour12 + ':' + m;
  }
  function getThreadAvatar(thread) {
    if (thread.type === 'group') return { initial: thread.title.charAt(0), color: '#3D6B6B' };
    const peer = (thread.participants || []).find((n) => n !== SELF_MEMBER) || thread.title;
    return { initial: getAvatarInitial(peer), color: getAvatarColor(peer) };
  }
  function getLastMessageTime(thread) {
    const last = thread.messages[thread.messages.length - 1];
    return last?.createdAt ? formatRelativeTime(last.createdAt) : '';
  }
"""

# Insert after "const SELF_MEMBER = '나';"
anchor = "  const SELF_MEMBER = '나';"
if "AVATAR_COLORS" not in js:
    js = js.replace(anchor, anchor + UTIL_FUNCTIONS, 1)
    print("[PATCH 1] 유틸 함수 추가 완료")
else:
    print("[PATCH 1] 이미 적용됨, 스킵")

# ============================================================
# PATCH 2: 채팅방 목록 아이템에 아바타 + 시간 추가
# ============================================================
# 기존: el('div', { class: 'egd-codex-thread-item-row' },
#          el('div', { class: 'egd-codex-thread-title' }, thread.title),
# 변경: 아바타 원형 + 제목/시간 행

OLD_THREAD_ITEM = """          item.append(
            el('div', { class: 'egd-codex-thread-item-row' },
              el('div', { class: 'egd-codex-thread-title' }, thread.title),
              el('div', { class: 'egd-codex-thread-item-actions' },
                thread.unreadCount > 0
                  ? el('span', { class: 'egd-codex-thread-unread' }, String(thread.unreadCount))
                  : null,
                el('button', {
                  class: `egd-codex-thread-menu-trigger${threadMenuOpen ? ' egd-codex-thread-menu-trigger-active' : ''}`,
                  title: '채팅방 메뉴',
                  onclick: (ev) => {
                    ev.stopPropagation();
                    codexBridge.toggleThreadMenu(thread.id, ev.currentTarget);
                  },
                }, '⋯'),
              ),
            ),
            el('div', { class: 'egd-codex-thread-preview' }, codexThreadPreview(thread)),
          );"""

NEW_THREAD_ITEM = """          const avatar = getThreadAvatar(thread);
          const avatarEl = el('div', {
            class: 'egd-codex-thread-avatar',
            style: `background:${avatar.color}`,
          }, avatar.initial);
          item.append(
            el('div', { class: 'egd-codex-thread-item-row' },
              avatarEl,
              el('div', { class: 'egd-codex-thread-item-content' },
                el('div', { class: 'egd-codex-thread-item-top' },
                  el('div', { class: 'egd-codex-thread-title' }, thread.title),
                  el('div', { class: 'egd-codex-thread-time' }, getLastMessageTime(thread)),
                ),
                el('div', { class: 'egd-codex-thread-item-bottom' },
                  el('div', { class: 'egd-codex-thread-preview' }, codexThreadPreview(thread)),
                  el('div', { class: 'egd-codex-thread-item-actions' },
                    thread.unreadCount > 0
                      ? el('span', { class: 'egd-codex-thread-unread' }, String(thread.unreadCount))
                      : null,
                    el('button', {
                      class: `egd-codex-thread-menu-trigger${threadMenuOpen ? ' egd-codex-thread-menu-trigger-active' : ''}`,
                      title: '채팅방 메뉴',
                      onclick: (ev) => {
                        ev.stopPropagation();
                        codexBridge.toggleThreadMenu(thread.id, ev.currentTarget);
                      },
                    }, '⋯'),
                  ),
                ),
              ),
            ),
          );"""

if "egd-codex-thread-avatar" not in js:
    if OLD_THREAD_ITEM in js:
        js = js.replace(OLD_THREAD_ITEM, NEW_THREAD_ITEM, 1)
        print("[PATCH 2] 채팅방 목록 아바타+시간 추가 완료")
    else:
        print("[PATCH 2] WARNING: 기존 코드 패턴 매칭 실패, 수동 확인 필요")
else:
    print("[PATCH 2] 이미 적용됨, 스킵")

# ============================================================
# PATCH 3: 메시지 버블에 타임스탬프 + 그룹핑
# ============================================================
OLD_MESSAGE_LOOP = """        } else {
          for (const message of activeThread.messages) {
            const content = el('div', { class: 'egd-codex-bubble-content egd-codex-richtext' });
            appendLinkedText(content, message.content || (message.status === 'streaming' ? '…' : ''));
            const bubble = el('div', {
              class: `egd-codex-bubble egd-codex-bubble-${message.role}${message.status === 'error' ? ' egd-codex-bubble-error' : ''}`,
            },
            el('div', { class: 'egd-codex-bubble-role' }, codexMessageRoleLabel(message.role)),
            content,
            );
            if (message.role === 'user') {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-read' }, codexReadMeta(message, activeThread)));
            }
            if (message.status === 'streaming' && message.role === 'assistant') {
              bubble.appendChild(el('div', { class: 'egd-codex-streaming' }, '응답 생성 중…'));
            }
            messages.appendChild(el('div', {
              class: `egd-codex-message-row egd-codex-message-row-${message.role || 'assistant'}`,
            }, bubble));
          }
        }"""

NEW_MESSAGE_LOOP = """        } else {
          let prevRole = null;
          let prevTime = 0;
          for (let mi = 0; mi < activeThread.messages.length; mi++) {
            const message = activeThread.messages[mi];
            const nextMsg = activeThread.messages[mi + 1];
            const sameRoleAsPrev = message.role === prevRole;
            const sameRoleAsNext = nextMsg && nextMsg.role === message.role;
            const timeDiff = message.createdAt - prevTime;
            const isGrouped = sameRoleAsPrev && timeDiff < 60000;
            const content = el('div', { class: 'egd-codex-bubble-content egd-codex-richtext' });
            appendLinkedText(content, message.content || (message.status === 'streaming' ? '…' : ''));
            const bubble = el('div', {
              class: `egd-codex-bubble egd-codex-bubble-${message.role}${message.status === 'error' ? ' egd-codex-bubble-error' : ''}${isGrouped ? ' egd-codex-bubble-grouped' : ''}`,
            });
            if (!isGrouped) {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-role' }, codexMessageRoleLabel(message.role)));
            }
            bubble.appendChild(content);
            const showTime = !sameRoleAsNext || (nextMsg && (nextMsg.createdAt - message.createdAt) >= 60000);
            if (showTime && message.createdAt) {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-time' }, formatMessageTime(message.createdAt)));
            }
            if (message.role === 'user') {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-read' }, codexReadMeta(message, activeThread)));
            }
            if (message.status === 'streaming' && message.role === 'assistant') {
              bubble.appendChild(el('div', { class: 'egd-codex-streaming' }, '응답 생성 중…'));
            }
            const row = el('div', {
              class: `egd-codex-message-row egd-codex-message-row-${message.role || 'assistant'}${isGrouped ? ' egd-codex-message-row-grouped' : ''}`,
            }, bubble);
            messages.appendChild(row);
            prevRole = message.role;
            prevTime = message.createdAt || 0;
          }
        }"""

if "egd-codex-bubble-grouped" not in js:
    if OLD_MESSAGE_LOOP in js:
        js = js.replace(OLD_MESSAGE_LOOP, NEW_MESSAGE_LOOP, 1)
        print("[PATCH 3] 메시지 그룹핑+타임스탬프 추가 완료")
    else:
        print("[PATCH 3] WARNING: 기존 코드 패턴 매칭 실패, 수동 확인 필요")
else:
    print("[PATCH 3] 이미 적용됨, 스킵")

# ============================================================
# PATCH 4: CSS 추가
# ============================================================
CSS_PATCH = """
/* === Phase 1 Chat UI 개선 === */
.egd-codex-thread-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
}
.egd-codex-thread-item-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.egd-codex-thread-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.egd-codex-thread-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.egd-codex-thread-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--egd-on-surface-variant);
  white-space: nowrap;
}
.egd-codex-thread-item-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.egd-codex-thread-item-bottom .egd-codex-thread-preview {
  flex: 1;
  min-width: 0;
}
.egd-codex-thread-item-bottom .egd-codex-thread-item-actions {
  flex-shrink: 0;
}
.egd-codex-bubble-grouped {
  padding-top: 2px;
}
.egd-codex-bubble-time {
  margin-top: 4px;
  font-size: 9px;
  color: var(--egd-on-surface-variant);
}
.egd-codex-message-row-grouped {
  margin-top: -6px;
}
"""

if "Phase 1 Chat UI" not in css:
    css += CSS_PATCH
    print("[PATCH 4] CSS 추가 완료")
else:
    print("[PATCH 4] 이미 적용됨, 스킵")

# ============================================================
# Write files
# ============================================================
with open(JS_FILE, "w", encoding="utf-8") as f:
    f.write(js)
with open(CSS_FILE, "w", encoding="utf-8") as f:
    f.write(css)

print("\n=== 패치 적용 완료 ===")
print(f"JS: {JS_FILE}")
print(f"CSS: {CSS_FILE}")
print("Firefox 재시작 필요: startup cache 클리어 후 재실행")
