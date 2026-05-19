import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, CheckCircle, Brain } from 'lucide-react'
import { marked } from 'marked'

marked.setOptions({ breaks: true, gfm: true })

const SUGGESTED_QUESTIONS = [
  'What are the top drivers of late first case starts?',
  'Which service lines have the longest turnover times?',
  'How is VORH OR performing on prime time utilization?',
  'What happens to turnover time when the same surgeon does back-to-back cases?',
  'Which locations are most affected by add-on cases?',
  'How does scheduling cases further ahead affect first case start times?',
]

/* ─── Shared sub-components ──────────────────────────────────────────────── */

function NuraMark({ size = 14, color = 'white' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path
        d="M3 14.5V3.5L9 9L15 3.5V14.5"
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AssistantAvatar() {
  return (
    <div style={{
      width: 28, height: 28,
      background: 'var(--color-navy-800)',
      borderRadius: 'var(--radius-md)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      marginBottom: 6, flexShrink: 0,
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }}>
      <NuraMark />
    </div>
  )
}

function SourceBadges({ sources }) {
  const hasLive  = sources?.includes('live_data')
  const hasModel = sources?.includes('model_insight')
  if (!hasLive && !hasModel) return null

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      {hasLive && (
        <span
          title="Verified against live data queried directly from your OR database."
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'var(--color-blue-muted)', color: 'var(--color-blue)',
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            padding: '3px 9px', borderRadius: 'var(--radius-full)',
            cursor: 'default', userSelect: 'none',
          }}
        >
          <CheckCircle size={10} />
          Live Data
        </span>
      )}
      {hasModel && (
        <span
          title="Draws on the EBM predictive model trained on your historical OR data."
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'var(--color-success-light)', color: '#15803d',
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            padding: '3px 9px', borderRadius: 'var(--radius-full)',
            cursor: 'default', userSelect: 'none',
          }}
        >
          <Brain size={10} />
          Model Insight
        </span>
      )}
    </div>
  )
}

/* ─── Message bubbles ────────────────────────────────────────────────────── */

function UserBubble({ content }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
      <div style={{
        maxWidth: '66%',
        background: 'var(--color-blue)',
        color: 'white',
        padding: '10px 15px',
        borderRadius: '16px 16px 4px 16px',
        fontSize: 'var(--font-size-base)',
        lineHeight: 'var(--line-height-normal)',
        wordBreak: 'break-word',
        boxShadow: '0 2px 8px rgba(62,83,227,0.25)',
      }}>
        {content}
      </div>
    </div>
  )
}

function AssistantBubble({ content, sources }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 'var(--space-4)' }}>
      <div style={{ maxWidth: '72%' }}>
        <AssistantAvatar />
        <div
          className="ask-nura-response"
          style={{
            background: 'var(--surface-card)',
            border: '1px solid var(--surface-border)',
            padding: '10px 15px',
            borderRadius: '4px 16px 16px 16px',
            fontSize: 'var(--font-size-base)',
            lineHeight: 'var(--line-height-relaxed)',
            color: 'var(--color-gray-700)',
            boxShadow: 'var(--shadow-xs)',
            wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: marked.parse(content) }}
        />
        <SourceBadges sources={sources} />
      </div>
    </div>
  )
}

function LoadingBubble() {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 'var(--space-4)' }}>
      <div>
        <AssistantAvatar />
        <div style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--surface-border)',
          padding: '13px 16px',
          borderRadius: '4px 16px 16px 16px',
          boxShadow: 'var(--shadow-xs)',
          display: 'flex',
          gap: 5,
          alignItems: 'center',
        }}>
          {[0, 1, 2].map(i => (
            <span
              key={i}
              style={{
                width: 7, height: 7,
                borderRadius: '50%',
                background: 'var(--color-gray-400)',
                display: 'inline-block',
                animation: `nuraDotBounce 1.2s ease-in-out ${i * 0.15}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─── Suggestion card ────────────────────────────────────────────────────── */

function SuggestionCard({ question, onSelect }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={() => onSelect(question)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--color-blue-light)' : 'var(--surface-card)',
        border: `1px solid ${hovered ? 'var(--color-blue)' : 'var(--surface-border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4) var(--space-5)',
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 'var(--font-size-sm)',
        color: hovered ? 'var(--color-blue)' : 'var(--color-gray-700)',
        fontWeight: hovered ? 500 : 400,
        lineHeight: 'var(--line-height-snug)',
        boxShadow: hovered ? 'var(--shadow-blue)' : 'var(--shadow-xs)',
        transform: hovered ? 'translateY(-1px)' : 'none',
        transition: 'all var(--transition-base)',
        fontFamily: 'inherit',
      }}
    >
      {question}
    </button>
  )
}

/* ─── Empty state ────────────────────────────────────────────────────────── */

function EmptyState({ onSelect }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-8)',
    }}>
      <div style={{
        width: 52, height: 52,
        background: 'var(--color-blue-muted)',
        borderRadius: 'var(--radius-xl)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 'var(--space-4)',
      }}>
        <NuraMark size={22} color="var(--color-blue)" />
      </div>

      <h2 style={{
        fontSize: 'var(--font-size-lg)',
        fontWeight: 600,
        color: 'var(--color-gray-900)',
        marginBottom: 'var(--space-2)',
        textAlign: 'center',
        letterSpacing: 'var(--letter-spacing-tight)',
      }}>
        What would you like to know?
      </h2>
      <p style={{
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-gray-500)',
        marginBottom: 'var(--space-8)',
        textAlign: 'center',
        maxWidth: 420,
        lineHeight: 'var(--line-height-normal)',
      }}>
        Ask about OR metrics, service line performance, model-predicted drivers, or anything in your data.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 'var(--space-3)',
        width: '100%',
        maxWidth: 700,
      }}>
        {SUGGESTED_QUESTIONS.map(q => (
          <SuggestionCard key={q} question={q} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

/* ─── Main page ──────────────────────────────────────────────────────────── */

export default function AskNura() {
  const [messages, setMessages] = useState([])
  const [history,  setHistory]  = useState([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const threadRef = useRef(null)
  const inputRef  = useRef(null)

  // Auto-scroll when messages update or loading state changes
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight
    }
  }, [messages, loading])

  // Auto-resize textarea up to 3 lines (~120px)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [input])

  const send = useCallback(async (text) => {
    const q = (typeof text === 'string' ? text : input).trim()
    if (!q || loading) return
    setInput('')

    setMessages(prev => [...prev, { role: 'user', content: q }])
    setLoading(true)

    try {
      const res = await fetch('/api/ask-nura', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, conversationHistory: history }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()

      const reply = {
        role: 'assistant',
        content: data.response ?? 'No response received.',
        sources: data.sources ?? [],
      }
      setMessages(prev => [...prev, reply])
      setHistory(prev => [
        ...prev,
        { role: 'user',      content: q },
        { role: 'assistant', content: reply.content },
      ])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Something went wrong: ${err.message}. Please check the server and try again.`,
        sources: [],
      }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, history])

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const canSend = input.trim().length > 0 && !loading
  const hasMessages = messages.length > 0 || loading

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - 64px)',
      overflow: 'hidden',
      background: 'var(--surface-bg)',
    }}>
      {/* Bounce animation + response markdown styles */}
      <style>{`
        @keyframes nuraDotBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30%            { transform: translateY(-6px); opacity: 1; }
        }

        .ask-nura-response > *:first-child { margin-top: 0; }
        .ask-nura-response > *:last-child  { margin-bottom: 0; }
        .ask-nura-response p               { margin: 0 0 0.6em; line-height: 1.625; }
        .ask-nura-response p:last-child    { margin-bottom: 0; }

        .ask-nura-response strong          { font-weight: 600; color: var(--color-gray-900); }

        .ask-nura-response ul,
        .ask-nura-response ol              { margin: 0.4em 0 0.6em 1.25em; padding: 0; }
        .ask-nura-response li              { margin-bottom: 0.25em; line-height: 1.5; }
        .ask-nura-response li:last-child   { margin-bottom: 0; }

        .ask-nura-response table {
          width: 100%;
          border-collapse: collapse;
          margin: 0.75em 0;
          font-size: var(--font-size-sm);
        }
        .ask-nura-response th {
          padding: 8px 12px;
          text-align: left;
          font-weight: 600;
          font-size: var(--font-size-xs);
          color: var(--color-gray-500);
          letter-spacing: 0.04em;
          text-transform: uppercase;
          background: var(--color-gray-50);
          border-bottom: 1px solid var(--color-gray-200);
          border-top: 1px solid var(--color-gray-200);
          white-space: nowrap;
        }
        .ask-nura-response td {
          padding: 8px 12px;
          border-bottom: 1px solid var(--color-gray-100);
          color: var(--color-gray-700);
          vertical-align: middle;
        }
        .ask-nura-response tr:last-child td  { border-bottom: none; }
        .ask-nura-response tbody tr:nth-child(even) td {
          background: var(--color-gray-50);
        }
      `}</style>

      {/* ── Page header ── */}
      <div style={{
        padding: 'var(--space-6) var(--space-8) var(--space-5)',
        background: 'var(--surface-card)',
        borderBottom: '1px solid var(--surface-border)',
        flexShrink: 0,
      }}>
        <h1 style={{
          fontSize: 'var(--font-size-2xl)',
          fontWeight: 700,
          color: 'var(--color-gray-900)',
          letterSpacing: 'var(--letter-spacing-tight)',
          lineHeight: 'var(--line-height-tight)',
        }}>
          Ask Nura
        </h1>
        <p style={{
          marginTop: 'var(--space-1)',
          fontSize: 'var(--font-size-base)',
          color: 'var(--color-gray-500)',
        }}>
          Query your OR data and model insights in plain English
        </p>
      </div>

      {/* ── Conversation thread ── */}
      <div
        ref={threadRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          padding: hasMessages ? 'var(--space-6) var(--space-8)' : 0,
        }}
      >
        {!hasMessages ? (
          <EmptyState onSelect={send} />
        ) : (
          <div style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
            {messages.map((m, i) =>
              m.role === 'user'
                ? <UserBubble      key={i} content={m.content} />
                : <AssistantBubble key={i} content={m.content} sources={m.sources} />
            )}
            {loading && <LoadingBubble />}
          </div>
        )}
      </div>

      {/* ── Input bar ── */}
      <div style={{
        padding: 'var(--space-4) var(--space-8)',
        background: 'var(--surface-card)',
        borderTop: '1px solid var(--surface-border)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'flex-end',
          maxWidth: 860,
          margin: '0 auto',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            placeholder="Ask about OR performance, utilization, turnover times, or model drivers…"
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              border: '1px solid var(--surface-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '10px 14px',
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-gray-900)',
              background: loading ? 'var(--color-gray-100)' : 'var(--color-white)',
              outline: 'none',
              lineHeight: 'var(--line-height-normal)',
              fontFamily: 'inherit',
              minHeight: 42,
              maxHeight: 120,
              overflowY: 'auto',
              transition: 'border-color var(--transition-base), box-shadow var(--transition-base), background var(--transition-base)',
            }}
            onFocus={e => {
              if (!loading) {
                e.target.style.borderColor = 'var(--color-blue)'
                e.target.style.boxShadow = '0 0 0 3px var(--color-blue-muted)'
              }
            }}
            onBlur={e => {
              e.target.style.borderColor = 'var(--surface-border)'
              e.target.style.boxShadow = 'none'
            }}
          />
          <button
            onClick={() => send()}
            disabled={!canSend}
            style={{
              width: 42,
              height: 42,
              borderRadius: 'var(--radius-lg)',
              background: canSend ? 'var(--color-blue)' : 'var(--color-gray-200)',
              color: canSend ? 'white' : 'var(--color-gray-400)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              cursor: canSend ? 'pointer' : 'not-allowed',
              boxShadow: canSend ? 'var(--shadow-blue)' : 'none',
              transition: 'background var(--transition-base), color var(--transition-base), box-shadow var(--transition-base)',
              flexShrink: 0,
            }}
          >
            <Send size={17} />
          </button>
        </div>
        <p style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-gray-400)',
          textAlign: 'center',
          marginTop: 'var(--space-2)',
        }}>
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
