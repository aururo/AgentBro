// Minimal CDP client over the platform WebSocket (spec C10.5: Node >= 22 ships
// one, so the plugin adds no dependency).
//
// Deliberately smaller than browser-hub's client: request/response routing by id,
// event subscription by method, and a default session so page-level commands do
// not have to repeat the sessionId. No reconnection, no retries — a recording is
// short-lived and a dropped socket means the recording is over.

/**
 * @param {{ WebSocketImpl?: any }} [deps] injected in tests
 */
export function createCdp(deps = {}) {
  const WebSocketImpl = deps.WebSocketImpl ?? globalThis.WebSocket
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('WebSocket is not available in this host (Node >= 22 required for recording)')
  }

  /**
   * @param {string} url
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  function connect(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000
    const socket = new WebSocketImpl(url)
    /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    const pending = new Map()
    /** @type {Map<string, Set<(params: any) => void>>} */
    const listeners = new Map()
    let messageId = 0
    let closed = false
    let defaultSessionId

    const keyOf = (sessionId, discriminator) => `${sessionId ?? 'main'}:${discriminator}`

    const conn = {
      isConnected: () => !closed,
      /** @type {string | undefined} */
      get defaultSessionId() {
        return defaultSessionId
      },
      set defaultSessionId(value) {
        defaultSessionId = value
      },
      /**
       * @param {string} method
       * @param {Record<string, unknown>} [params]
       * @param {string} [sessionId]
       * @returns {Promise<any>}
       */
      send(method, params = {}, sessionId) {
        if (closed) return Promise.reject(new Error('CDP connection is closed'))
        const sid = sessionId ?? (String(method).startsWith('Target.') ? undefined : defaultSessionId)
        const id = ++messageId
        const message = { id, method, params }
        if (sid !== undefined) message.sessionId = sid
        return new Promise((resolve, reject) => {
          pending.set(keyOf(sid, String(id)), { resolve, reject })
          try {
            socket.send(JSON.stringify(message))
          } catch (error) {
            pending.delete(keyOf(sid, String(id)))
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      },
      /**
       * @param {string} method
       * @param {(params: any) => void} handler
       * @param {string} [sessionId]
       * @returns {() => void} unsubscribe
       */
      on(method, handler, sessionId) {
        const sid = sessionId ?? (String(method).startsWith('Target.') ? undefined : defaultSessionId)
        const key = keyOf(sid, String(method))
        const set = listeners.get(key) ?? new Set()
        set.add(handler)
        listeners.set(key, set)
        return () => {
          const current = listeners.get(key)
          if (current === undefined) return
          current.delete(handler)
          if (current.size === 0) listeners.delete(key)
        }
      },
      close() {
        if (closed) return
        closed = true
        for (const [, entry] of pending) entry.reject(new Error('CDP connection closed'))
        pending.clear()
        listeners.clear()
        try {
          socket.close()
        } catch {
          // Closing an already-dead socket is not an error worth surfacing.
        }
      },
    }

    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        conn.close()
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onOpen = () => {
        cleanup()
        resolve(undefined)
      }
      const onError = () => {
        cleanup()
        conn.close()
        reject(new Error('CDP connect failed'))
      }
      const onAbort = () => {
        cleanup()
        conn.close()
        reject(new Error('CDP connect aborted'))
      }
      function cleanup() {
        clearTimeout(timer)
        if (typeof socket.removeEventListener === 'function') {
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('error', onError)
        }
        options.signal?.removeEventListener('abort', onAbort)
      }
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onError)
      } else {
        socket.onopen = onOpen
        socket.onerror = onError
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('message', (event) => onMessage(event?.data))
      socket.addEventListener('close', () => {
        closed = true
        for (const [, entry] of pending) entry.reject(new Error('CDP connection closed'))
        pending.clear()
      })
    } else {
      socket.onmessage = (event) => onMessage(event?.data)
      socket.onclose = () => {
        closed = true
        for (const [, entry] of pending) entry.reject(new Error('CDP connection closed'))
        pending.clear()
      }
    }

    /** @param {unknown} data */
    function onMessage(data) {
      let msg
      try {
        msg = JSON.parse(typeof data === 'string' ? data : String(data))
      } catch {
        return
      }
      if (msg?.id !== undefined) {
        const entry = pending.get(keyOf(msg.sessionId, String(msg.id)))
        if (entry === undefined) return
        pending.delete(keyOf(msg.sessionId, String(msg.id)))
        if (msg.error) entry.reject(new Error(String(msg.error.message ?? 'CDP error')))
        else entry.resolve(msg.result)
        return
      }
      if (typeof msg?.method === 'string') {
        const set = listeners.get(keyOf(msg.sessionId, msg.method))
        if (set === undefined) return
        for (const handler of set) {
          try {
            handler(msg.params)
          } catch {
            // A throwing listener must not take the capture down with it.
          }
        }
      }
    }

    return { conn, opened }
  }

  return { connect }
}
