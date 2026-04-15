import { useEffect, useMemo, useState } from 'react'
import type {
  CodexAuthStatus,
  CodexChatMessage,
  CodexDesktopEvent
} from '../../../shared/codex'

const unauthenticatedStatus: CodexAuthStatus = {
  isLoggedIn: false,
  authMode: null,
  accountId: null,
  accountEmail: null,
  lastRefresh: null,
  source: 'none',
  statusText: 'Login required'
}

function createUserMessage(content: string): CodexChatMessage {
  return {
    id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    status: 'complete',
    createdAt: Date.now()
  }
}

export function useCodexChat() {
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus>(unauthenticatedStatus)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CodexChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isStartingLogin, setIsStartingLogin] = useState(false)
  const [loginLog, setLoginLog] = useState('')
  const [error, setError] = useState<string | null>(null)
  const codexApi =
    typeof window !== 'undefined' && 'api' in window ? window.api?.codex : undefined

  useEffect(() => {
    let mounted = true

    if (!codexApi) {
      setError('Codex desktop bridge is unavailable. Check the preload process.')
      return
    }

    void codexApi.getAuthStatus().then((status) => {
      if (mounted) setAuthStatus(status)
    })

    const unsubscribe = codexApi.subscribe((event: CodexDesktopEvent) => {
      switch (event.type) {
        case 'auth-status':
          setAuthStatus(event.status)
          return
        case 'login-started':
          setIsStartingLogin(true)
          setLoginLog('')
          setError(null)
          return
        case 'login-output':
          setLoginLog((prev) => `${prev}${event.chunk}`)
          return
        case 'login-finished':
          setIsStartingLogin(false)
          setAuthStatus(event.status)
          if (!event.success) {
            setError('Codex login did not complete. Check the device auth output below.')
          }
          return
        case 'assistant-start':
          setConversationId(event.conversationId)
          setMessages((prev) => [...prev, event.message])
          return
        case 'assistant-delta':
          setMessages((prev) =>
            prev.map((message) =>
              message.id === event.messageId
                ? { ...message, content: `${message.content}${event.delta}` }
                : message
            )
          )
          return
        case 'assistant-complete':
          setIsSending(false)
          setMessages((prev) =>
            prev.map((message) =>
              message.id === event.messageId ? { ...message, status: 'complete' } : message
            )
          )
          return
        case 'assistant-error':
          setIsSending(false)
          setError(event.error)
          setMessages((prev) =>
            prev.map((message) =>
              message.id === event.messageId
                ? { ...message, content: event.error, status: 'error' }
                : message
            )
          )
          return
      }
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [codexApi])

  const canSend = useMemo(
    () =>
      Boolean(codexApi) &&
      authStatus.isLoggedIn &&
      draft.trim().length > 0 &&
      !isSending &&
      !isStartingLogin,
    [authStatus.isLoggedIn, codexApi, draft, isSending, isStartingLogin]
  )

  async function refreshAuthStatus(): Promise<void> {
    if (!codexApi) return
    const status = await codexApi.getAuthStatus()
    setAuthStatus(status)
  }

  async function startLogin(): Promise<void> {
    if (!codexApi) return
    setError(null)
    const result = await codexApi.startDeviceAuth()
    if (!result.started) {
      setError(result.message)
      await refreshAuthStatus()
    }
  }

  async function signOut(): Promise<void> {
    if (!codexApi) return
    setError(null)
    const status = await codexApi.signOut()
    setAuthStatus(status)
    setConversationId(null)
    setMessages([])
  }

  async function sendMessage(): Promise<void> {
    if (!codexApi) {
      setError('Codex desktop bridge is unavailable. Check the preload process.')
      return
    }
    const content = draft.trim()
    if (!content) return

    setError(null)
    setIsSending(true)
    setMessages((prev) => [...prev, createUserMessage(content)])
    setDraft('')

    const result = await codexApi.sendMessage({
      conversationId: conversationId ?? undefined,
      message: content
    })

    setConversationId(result.conversationId)

    if (!result.accepted && result.error) {
      setIsSending(false)
      setError(result.error)
    }
  }

  return {
    authStatus,
    conversationId,
    messages,
    draft,
    setDraft,
    loginLog,
    error,
    isSending,
    isStartingLogin,
    canSend,
    refreshAuthStatus,
    startLogin,
    signOut,
    sendMessage
  }
}
