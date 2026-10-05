import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { useCallback } from 'react'
import { terminalBufferClear, terminalInputSend } from '../terminal/mobile-terminal-operations'
import {
  clearTerminalLiveInputFocusTimer,
  scheduleTerminalLiveInputFocus
} from '../terminal/terminal-live-input'
import { sendMobileTerminalQueryReply } from '../terminal/mobile-terminal-query-reply'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import { countTerminalGestureInputSequences } from '../terminal/terminal-gesture-input'
import {
  isGestureMouseTrackingMode,
  TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
  TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS,
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
} from './mobile-session-route-helpers'
import type { Terminal } from './mobile-session-route-types'
import {
  appendTerminalGestureInput,
  countQueuedTerminalGestureSequences,
  createTerminalGestureInputQueue,
  pruneTerminalGestureInputQueue,
  queuedTerminalGestureInputBytes
} from './terminal-gesture-input-queue'
import type { MobileSessionFileActionsModel } from './use-mobile-session-file-actions'

export function useMobileSessionTerminalInput(scope: MobileSessionFileActionsModel) {
  const {
    client,
    connState,
    toggleTerminalLiveInput,
    activeHandle,
    ptyModesRef,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    deviceTokenRef,
    clientRef,
    connStateRef,
    liveInputRef,
    liveInputFocusTimerRef,
    terminalUnsubsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    clearPendingLiveInputCommit,
    showToast,
    getTerminalRef,
    hostQueryReplyInputSupportedRef
  } = scope
  const toggleLiveInput = useCallback(() => {
    if (!activeHandle) {
      return
    }
    const nextEnabled = toggleTerminalLiveInput(activeHandle)
    clearPendingLiveInputCommit()
    if (nextEnabled) {
      scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => liveInputRef.current?.focus())
    } else {
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      liveInputRef.current?.blur()
    }
  }, [activeHandle, clearPendingLiveInputCommit, toggleTerminalLiveInput])

  const allowTerminalGestureInput = useCallback(
    (handle: string, sequenceCount: number): boolean => {
      const now = Date.now()
      const current = terminalGestureInputBucketsRef.current.get(handle) ?? {
        tokens: TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        lastRefillMs: now
      }
      const elapsedSeconds = Math.max(0, now - current.lastRefillMs) / 1000
      const tokens = Math.min(
        TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        current.tokens + elapsedSeconds * TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
      )

      // Why: tokens count terminal control sequences, not WebView messages; one gesture may batch up to 32 wheel/key reports.
      if (tokens < sequenceCount) {
        terminalGestureInputBucketsRef.current.set(handle, { tokens, lastRefillMs: now })
        return false
      }

      terminalGestureInputBucketsRef.current.set(handle, {
        tokens: tokens - sequenceCount,
        lastRefillMs: now
      })
      return true
    },
    []
  )

  const flushTerminalGestureInput = useCallback(async (handle: string) => {
    const queued = terminalGestureInputQueuesRef.current.get(handle)
    if (!queued) {
      return
    }
    if (queued.timer) {
      clearTimeout(queued.timer)
      queued.timer = null
    }
    if (terminalGestureInputInFlightRef.current.has(handle)) {
      return
    }

    terminalGestureInputQueuesRef.current.delete(handle)
    // Why: gesture arrows parked across a reconnect or a slow ack would move a TUI long after the swipe.
    pruneTerminalGestureInputQueue(queued, Date.now())
    const bytes = queuedTerminalGestureInputBytes(queued)
    const isActive =
      handle === activeHandleRef.current && activeSessionTabTypeRef.current === 'terminal'
    const rpc = clientRef.current
    if (!rpc || connStateRef.current !== 'connected' || !isActive || bytes.length === 0) {
      return
    }

    terminalGestureInputInFlightRef.current.add(handle)
    try {
      const response = await terminalInputSend.request(
        rpc,
        buildTerminalSendParams({
          terminal: handle,
          text: bytes,
          enter: false,
          deviceToken: deviceTokenRef.current
        }),
        TERMINAL_INPUT_SEND_OPTIONS
      )
      if (terminalInputSend.interpret(response) === true) {
        reportWorkerTerminalUserInput(rpc, handle)
      }
    } catch {
      // Transient failure
    } finally {
      terminalGestureInputInFlightRef.current.delete(handle)
      if (terminalGestureInputQueuesRef.current.has(handle)) {
        void flushTerminalGestureInput(handle)
      }
    }
  }, [])

  const enqueueTerminalGestureInput = useCallback(
    (handle: string, bytes: string, sequenceCount: number) => {
      const now = Date.now()
      const current = terminalGestureInputQueuesRef.current.get(handle)
      if (
        current &&
        countQueuedTerminalGestureSequences(current) + sequenceCount <=
          TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
      ) {
        appendTerminalGestureInput(current, bytes, sequenceCount, now)
        return
      }

      if (current) {
        if (current.timer) {
          clearTimeout(current.timer)
        }
        if (!terminalGestureInputInFlightRef.current.has(handle)) {
          void flushTerminalGestureInput(handle)
        } else {
          // Why: a send is in flight, so this batch cannot go yet; keep the newest reports that still fit and are still fresh.
          appendTerminalGestureInput(current, bytes, sequenceCount, now)
          pruneTerminalGestureInputQueue(current, now)
          current.timer = setTimeout(() => {
            current.timer = null
            void flushTerminalGestureInput(handle)
          }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
          return
        }
      }

      const queued = createTerminalGestureInputQueue()
      appendTerminalGestureInput(queued, bytes, sequenceCount, now)
      queued.timer = setTimeout(() => {
        queued.timer = null
        void flushTerminalGestureInput(handle)
      }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
      terminalGestureInputQueuesRef.current.set(handle, queued)
    },
    [flushTerminalGestureInput]
  )

  const handleTerminalInput = useCallback(
    async (handle: string, bytes: string) => {
      if (!client || connState !== 'connected' || bytes.length === 0) {
        return
      }
      if (handle !== activeHandleRef.current || activeSessionTabTypeRef.current !== 'terminal') {
        return
      }
      const modes = ptyModesRef.current.get(handle)
      // Why: WebView gesture bytes can become PTY input, so gate mouse reports behind validation and SSH-safe rate limiting.
      if (!modes?.altScreen && !isGestureMouseTrackingMode(modes?.mouseTrackingMode)) {
        return
      }
      const sequenceCount = countTerminalGestureInputSequences(bytes)
      if (sequenceCount == null) {
        return
      }
      if (!allowTerminalGestureInput(handle, sequenceCount)) {
        return
      }
      enqueueTerminalGestureInput(handle, bytes, sequenceCount)
    },
    [allowTerminalGestureInput, client, connState, enqueueTerminalGestureInput]
  )

  const handleTerminalQueryReply = useCallback((handle: string, bytes: string) => {
    void sendMobileTerminalQueryReply({
      bytes,
      client: clientRef.current,
      clientId: deviceTokenRef.current,
      connected: connStateRef.current === 'connected',
      handle,
      hostSupportsQueryReplyInput: hostQueryReplyInputSupportedRef.current,
      subscribedTerminals: terminalUnsubsRef.current
    })
  }, [])

  async function handleClearTerminal(target: Terminal) {
    if (!client) {
      return
    }
    getTerminalRef(target.handle)?.clear()
    try {
      // The reply is unread: main toasted success on any fulfilled envelope, refusal included.
      await terminalBufferClear.request(client, { terminal: target.handle })
      showToast('Terminal cleared')
    } catch {
      showToast("Couldn't clear terminal", 1500)
    }
  }
  return {
    toggleLiveInput,
    allowTerminalGestureInput,
    flushTerminalGestureInput,
    enqueueTerminalGestureInput,
    handleTerminalInput,
    handleTerminalQueryReply,
    handleClearTerminal
  }
}

export type MobileSessionTerminalInputModel = MobileSessionFileActionsModel &
  ReturnType<typeof useMobileSessionTerminalInput>
