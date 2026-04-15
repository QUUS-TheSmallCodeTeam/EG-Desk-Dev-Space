export interface CodexAuthStatus {
  isLoggedIn: boolean
  authMode: string | null
  accountId: string | null
  accountEmail: string | null
  lastRefresh: number | null
  source: 'auth-json' | 'none'
  statusText: string
}

export interface StartCodexLoginResult {
  started: boolean
  message: string
}

export interface SendCodexChatMessageRequest {
  conversationId?: string
  message: string
}

export interface SendCodexChatMessageResult {
  accepted: boolean
  conversationId: string
  error?: string
}

export interface CodexChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'streaming' | 'complete' | 'error'
  createdAt: number
}

export type CodexDesktopEvent =
  | { type: 'auth-status'; status: CodexAuthStatus }
  | { type: 'login-started' }
  | { type: 'login-output'; chunk: string }
  | { type: 'login-finished'; success: boolean; status: CodexAuthStatus }
  | { type: 'assistant-start'; conversationId: string; message: CodexChatMessage }
  | { type: 'assistant-delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'assistant-complete'; conversationId: string; messageId: string }
  | { type: 'assistant-error'; conversationId: string; messageId: string; error: string }

export interface CodexDesktopApi {
  codex: {
    getAuthStatus: () => Promise<CodexAuthStatus>
    startDeviceAuth: () => Promise<StartCodexLoginResult>
    signOut: () => Promise<CodexAuthStatus>
    sendMessage: (
      request: SendCodexChatMessageRequest
    ) => Promise<SendCodexChatMessageResult>
    subscribe: (listener: (event: CodexDesktopEvent) => void) => () => void
  }
}
