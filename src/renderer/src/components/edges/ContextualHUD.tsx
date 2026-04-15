/**
 * Contextual HUD Panel — Right Edge (DESIGN_SYSTEM_SPEC.md §7-4)
 *
 * Frosted glass side panel. 320-400px wide.
 * Height: 80vh capped at 720px (within SPEC §7-4 70-80% range),
 * visually balanced with DeskRail top-4 (64px bottom) and Dock bottom-4 (72px top).
 * Dock app click → renders here as HUD. App-specific content.
 */
import { useCallback } from 'react'
import { createEntity, useCanvasStore } from '../../canvas/store'
import { useCodexChat } from '../../hooks/useCodexChat'
import Tooltip from '../Tooltip'
import { ChatBubble } from '../icons'

interface ContextualHUDProps {
  onClose: () => void
}

function ContextualHUD(props: ContextualHUDProps): JSX.Element {
  const chat = useCodexChat()
  const { state, dispatch } = useCanvasStore()

  const handlePinToCanvas = useCallback(() => {
    if (!chat.conversationId) return
    const size = { w: 320, h: 220 }
    const position = {
      x: (window.innerWidth * 0.56 - state.viewport.x) / state.viewport.k - size.w / 2,
      y: (window.innerHeight * 0.42 - state.viewport.y) / state.viewport.k - size.h / 2
    }

    dispatch({
      type: 'ADD_ENTITY',
      entity: createEntity(
        'chat',
        position,
        {
          conversationId: chat.conversationId,
          agentConfig: { source: 'hud', authMode: chat.authStatus.authMode ?? 'unknown' }
        },
        size
      )
    })
  }, [chat.authStatus.authMode, chat.conversationId, dispatch, state.viewport])

  const isLoggedIn = chat.authStatus.isLoggedIn

  return (
    <div
      data-testid="contextual-hud"
      className="glass pointer-events-auto fixed right-3 top-1/2 z-40 flex w-[340px] -translate-y-1/2 flex-col rounded-xl"
      style={{ height: 'min(80vh, 720px)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--outline-variant)] px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--primary-container)] text-[var(--primary)]">
          <ChatBubble className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[var(--on-surface)]">Chat / Agent</div>
          <div className="text-[11px] text-[var(--on-surface-variant)]">
            {chat.authStatus.statusText}
          </div>
        </div>
        <Tooltip label="Close HUD" side="left">
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close HUD"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--on-surface-variant)] transition hover:bg-white/60 hover:text-[var(--on-surface)]"
          >
            <span className="text-[14px] leading-none">×</span>
          </button>
        </Tooltip>
      </div>

      <div className="border-b border-[var(--outline-variant)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void chat.refreshAuthStatus()}
            className="rounded-md bg-white/60 px-2.5 py-1 text-[11px] text-[var(--on-surface)] transition hover:bg-white"
          >
            Refresh
          </button>
          {!isLoggedIn && (
            <button
              type="button"
              onClick={() => void chat.startLogin()}
              disabled={chat.isStartingLogin}
              className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[11px] text-white transition disabled:opacity-50"
            >
              {chat.isStartingLogin ? 'Logging in…' : 'Sign in with Codex'}
            </button>
          )}
          {isLoggedIn && (
            <button
              type="button"
              onClick={() => void chat.signOut()}
              className="rounded-md bg-white/60 px-2.5 py-1 text-[11px] text-[var(--on-surface)] transition hover:bg-white"
            >
              Sign out
            </button>
          )}
          <button
            type="button"
            onClick={handlePinToCanvas}
            disabled={!chat.conversationId}
            className="rounded-md bg-white/60 px-2.5 py-1 text-[11px] text-[var(--on-surface)] transition hover:bg-white disabled:opacity-50"
          >
            Pin to canvas
          </button>
        </div>
        <div className="mt-2 text-[11px] text-[var(--on-surface-variant)]">
          {isLoggedIn
            ? `Auth mode: ${chat.authStatus.authMode ?? 'unknown'}`
            : 'Device auth flow starts through Codex CLI and returns status into this HUD.'}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary-container)]">
              <ChatBubble className="h-6 w-6 text-[var(--primary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--on-surface)]">Codex chat</p>
            <p className="mt-1 text-[11px] text-[var(--on-surface-variant)]">
              Login-aware HUD shell scaffold.
              <br />
              Real Codex transport wiring lands next.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {chat.messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                  message.role === 'user'
                    ? 'ml-8 bg-[var(--primary-container)] text-[var(--on-surface)]'
                    : 'mr-8 bg-white/70 text-[var(--on-surface)]'
                }`}
              >
                <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--on-surface-variant)]">
                  {message.role}
                </div>
                <div className="whitespace-pre-wrap break-words">
                  {message.content || (message.status === 'streaming' ? '…' : '')}
                </div>
              </div>
            ))}
          </div>
        )}

        {(chat.error || chat.loginLog) && (
          <div className="mt-4 space-y-2">
            {chat.error && (
              <div className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[11px] text-[#8C2C2C]">
                {chat.error}
              </div>
            )}
            {chat.loginLog && (
              <pre className="max-h-40 overflow-auto rounded-lg bg-[#F1EFEA] px-3 py-2 text-[10px] text-[var(--on-surface-variant)] whitespace-pre-wrap">
                {chat.loginLog}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--outline-variant)] p-3">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void chat.sendMessage()
          }}
        >
          <div className="flex items-center gap-2 rounded-lg bg-white/60 px-3 py-2 ring-1 ring-inset ring-[var(--outline-variant)]">
            <input
              type="text"
              value={chat.draft}
              onChange={(event) => chat.setDraft(event.target.value)}
              placeholder={isLoggedIn ? 'Message Codex…' : 'Sign in to start chatting'}
              disabled={!isLoggedIn || chat.isStartingLogin}
              className="flex-1 bg-transparent text-[13px] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!chat.canSend}
              className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[11px] text-white transition disabled:opacity-50"
            >
              {chat.isSending ? '…' : 'Send'}
            </button>
          </div>
          <div className="flex items-center justify-between text-[10px] text-[var(--on-surface-variant)]">
            <span>{chat.conversationId ? `Conversation ${chat.conversationId}` : 'No conversation yet'}</span>
            <kbd className="rounded bg-[var(--outline-variant)] px-1.5 py-0.5 font-mono">↵</kbd>
          </div>
        </form>
      </div>
    </div>
  )
}

export default ContextualHUD
