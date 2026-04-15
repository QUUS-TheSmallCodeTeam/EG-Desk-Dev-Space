import React from 'react'

interface RootErrorBoundaryState {
  error: Error | null
}

export default class RootErrorBoundary extends React.Component<
  React.PropsWithChildren,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = {
    error: null
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[RootErrorBoundary]', error, errorInfo)
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          width: '100vw',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f5f3ef',
          color: '#1a1a1a',
          padding: 24
        }}
      >
        <div
          style={{
            maxWidth: 720,
            borderRadius: 16,
            border: '1px solid rgba(0,0,0,0.08)',
            background: 'rgba(255,255,255,0.82)',
            padding: 20,
            boxShadow: '0 10px 30px rgba(0,0,0,0.08)'
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Renderer crashed during startup
          </div>
          <div style={{ fontSize: 13, opacity: 0.72, marginBottom: 12 }}>
            The app caught a runtime error instead of showing a blank window.
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              lineHeight: 1.5
            }}
          >
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      </div>
    )
  }
}
