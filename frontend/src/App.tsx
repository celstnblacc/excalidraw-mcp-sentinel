import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import {
  computeElementHash,
  cleanElementForExcalidraw,
} from './utils/elementHelpers'
import type { ServerElement } from './utils/elementHelpers'
import { convertElementsPreservingImageProps, prepareElementsForScene } from './utils/scenePreparation'

type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  files?: Record<string, any>;
  [key: string]: any;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing';

interface TenantInfo {
  id: string;
  name: string;
  workspace_path: string;
}

declare global {
  interface Window {
    __EXCALIDRAW_API_KEY__?: string;
  }
}

const WS_AUTH_CLOSE_CODE = 4001
const browserApiKey = typeof window !== 'undefined' ? window.__EXCALIDRAW_API_KEY__ : undefined

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)
  const reconnectEnabledRef = useRef<boolean>(true)
  
  // Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    const stored = localStorage.getItem('excalidraw-autosave')
    return stored === null ? true : stored === 'true'
  })
  const isSyncingRef = useRef<boolean>(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastChangeTimeRef = useRef<number>(0)
  const [syncCountdown, setSyncCountdown] = useState<number | null>(null)
  const lastSyncedHashRef = useRef<string>('')
  const lastSeenHashRef = useRef<string>('')
  const lastSyncVersionRef = useRef<number>(
    parseInt(localStorage.getItem('excalidraw-last-sync-version') ?? '0', 10)
  )
  const lastSyncedElementsRef = useRef<Map<string, ServerElement>>(new Map())
  const lastReceivedSyncVersionRef = useRef<number>(0)
  const isResyncingRef = useRef<boolean>(false)

  const DEBOUNCE_MS = 3000

  // Track known container IDs to auto-inject title on new shapes
  const knownContainerIdsRef = useRef<Set<string>>(new Set())
  const CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])

  // Seed knownContainerIdsRef before updateScene to prevent re-injection on load/sync
  const seedKnownContainers = (elements: readonly { type: string; id: string }[]): void => {
    for (const el of elements) {
      if (CONTAINER_TYPES.has(el.type)) {
        knownContainerIdsRef.current.add(el.id)
      }
    }
  }

  // Custom font size input state
  const [customFontSize, setCustomFontSize] = useState<string>('')

  // Draggable widget state — default near top menu
  const [widgetPos, setWidgetPos] = useState<{x: number, y: number}>(() => {
    try {
      const saved = localStorage.getItem('font-widget-pos')
      return saved ? JSON.parse(saved) : { x: window.innerWidth * 0.55, y: 90 }
    } catch {
      return { x: window.innerWidth * 0.55, y: 90 }
    }
  })
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef<{x: number, y: number}>({x: 0, y: 0})

  // Tenant state
  const [activeTenant, setActiveTenant] = useState<TenantInfo | null>(null)
  const activeTenantIdRef = useRef<string | null>(null)
  const [tenantList, setTenantList] = useState<TenantInfo[]>([])
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [tenantSearch, setTenantSearch] = useState<string>('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Project state
  const [activeProject, setActiveProject] = useState<{ id: string; name: string } | null>(null)
  const [projectList, setProjectList] = useState<{ id: string; name: string; description: string | null }[]>([])
  const [projectMenuOpen, setProjectMenuOpen] = useState<boolean>(false)
  const [newProjectName, setNewProjectName] = useState<string>('')
  const [isCreatingProject, setIsCreatingProject] = useState<boolean>(false)
  const newProjectInputRef = useRef<HTMLInputElement | null>(null)
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null)
  const [confirmDeleteTenantId, setConfirmDeleteTenantId] = useState<string | null>(null)
  const [batchSelectMode, setBatchSelectMode] = useState<boolean>(false)
  const [selectedTenantIds, setSelectedTenantIds] = useState<Set<string>>(new Set())
  const [confirmBatchDelete, setConfirmBatchDelete] = useState<boolean>(false)

  // Keep refs in sync so closures (WebSocket handlers) always see latest values
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  useEffect(() => {
    activeTenantIdRef.current = activeTenant?.id ?? null
  }, [activeTenant])

  // Build headers with tenant ID for all fetch calls to the backend
  const tenantHeaders = (extra?: Record<string, string>): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra
    }
    const tid = activeTenantIdRef.current
    if (tid) headers['X-Tenant-Id'] = tid
    if (browserApiKey) headers['X-API-Key'] = browserApiKey
    return headers
  }

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()
      
      // Ensure WebSocket is connected for real-time updates
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  // Persist auto-save preference and cancel pending timer when toggled off
  const toggleAutoSave = () => {
    setAutoSave(prev => {
      const next = !prev
      localStorage.setItem('excalidraw-autosave', String(next))
      if (!next && debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      return next
    })
  }

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (pendingTitleTimerRef.current) clearTimeout(pendingTitleTimerRef.current)
    }
  }, [])

  // Called on every change. Waits for 400ms of idle before showing the countdown,
  // so the number only ticks when the user has stopped drawing.
  const scheduleCountdown = () => {
    lastChangeTimeRef.current = Date.now()
    // Reset any pending idle detection
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    // Hide countdown while actively drawing
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
      setSyncCountdown(null)
    }
    // Start showing countdown only after 400ms of no changes
    idleTimerRef.current = setTimeout(() => {
      const deadline = lastChangeTimeRef.current + DEBOUNCE_MS
      setSyncCountdown(Math.ceil((deadline - Date.now()) / 1000))
      countdownTimerRef.current = setInterval(() => {
        const remaining = Math.ceil((lastChangeTimeRef.current + DEBOUNCE_MS - Date.now()) / 1000)
        if (remaining <= 0) {
          clearInterval(countdownTimerRef.current!)
          countdownTimerRef.current = null
          setSyncCountdown(null)
        } else {
          setSyncCountdown(remaining)
        }
      }, 200)
    }, 400)
  }

  // Apply custom font size to selected elements
  const applyCustomFontSize = (size: number): void => {
    const api = excalidrawAPIRef.current
    if (!api || !size || size < 1) return

    const appState = api.getAppState()
    const selectedIds = appState.selectedElementIds || {}
    const scene = api.getSceneElements()
    const updated = scene.map((el: any) => {
      if (selectedIds[el.id] && (el.type === 'text' || (el as any).fontSize !== undefined)) {
        return { ...el, fontSize: size }
      }
      return el
    })
    api.updateScene({ elements: updated, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }

  // Pending title injection — deferred to avoid updateScene inside onChange
  const pendingTitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Trailing debounce: resets on every change, fires after user is idle.
  // Only active when auto-save is on.
  const handleCanvasChange = (): void => {
    // Check if elements actually changed — onChange fires for selection/appState too
    const currentElements = excalidrawAPIRef.current?.getSceneElements()
    const currentHash = currentElements ? computeElementHash(currentElements) : ''
    const elementsChanged = currentHash !== lastSeenHashRef.current
    if (elementsChanged) lastSeenHashRef.current = currentHash

    // Auto-inject title into new containers (rectangle, ellipse, diamond)
    // Deferred: collect candidates, inject after onChange completes
    if (pendingTitleTimerRef.current) clearTimeout(pendingTitleTimerRef.current)
    pendingTitleTimerRef.current = setTimeout(() => {
      const api = excalidrawAPIRef.current
      if (!api) return

      const elements = api.getSceneElements()
      const newContainers: typeof elements[number][] = []

      for (const el of elements) {
        if (
          CONTAINER_TYPES.has(el.type) &&
          !el.isDeleted &&
          !knownContainerIdsRef.current.has(el.id) &&
          el.width > 30 && el.height > 30
        ) {
          const hasBoundText = (el as any).boundElements?.some((b: any) => b.type === 'text')
          if (!hasBoundText) {
            newContainers.push(el)
          }
          knownContainerIdsRef.current.add(el.id)
        }
      }

      if (newContainers.length > 0) {
        const scene = api.getSceneElements()
        const updated = [...scene] as any[]

        for (const container of newContainers) {
          const groupId = `${container.id}_group`
          const textId = `${container.id}_title`
          const subtitleId = `${container.id}_subtitle`

          // Center-based positioning — works for all shapes
          const cx = container.x + container.width / 2
          const cy = container.y + container.height / 2

          // Title — 15% above center
          const titleConverted = convertToExcalidrawElements([{
            type: 'text' as const,
            id: textId,
            x: cx,
            y: cy - container.height * 0.15,
            text: 'Title',
            fontSize: 24,
            fontFamily: 6,
            textAlign: 'center' as const,
            strokeColor: '#1e1e1e',
          }], { regenerateIds: false })
          const titleText = titleConverted.map((el: any) => ({
            ...el,
            groupIds: [groupId],
          }))

          // Subtitle — 10% below center
          const subtitleConverted = convertToExcalidrawElements([{
            type: 'text' as const,
            id: subtitleId,
            x: cx,
            y: cy + container.height * 0.10,
            text: 'Text here',
            fontSize: 16,
            fontFamily: 6,
            textAlign: 'center' as const,
            strokeColor: '#868e96',
          }], { regenerateIds: false })
          const subtitleText = subtitleConverted.map((el: any) => ({
            ...el,
            groupIds: [groupId],
          }))

          // Add group to container
          const idx = updated.findIndex((e: any) => e.id === container.id)
          if (idx >= 0) {
            const existingGroups = (updated[idx] as any).groupIds || []
            updated[idx] = {
              ...updated[idx],
              groupIds: [...existingGroups, groupId]
            }
          }
          updated.push(...titleText, ...subtitleText)
        }

        api.updateScene({ elements: updated, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      }
    }, 300) // 300ms delay — fires after drawing finishes

    if (!autoSave || !elementsChanged) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    scheduleCountdown()

    debounceTimerRef.current = setTimeout(() => {
      if (!excalidrawAPI || isSyncingRef.current) return

      const currentElements = excalidrawAPI.getSceneElements()
      const hash = computeElementHash(currentElements)
      if (hash === lastSyncedHashRef.current) return

      syncToBackend()
    }, DEBOUNCE_MS)
  }

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch('/api/elements', { headers: tenantHeaders() })
      const result: ApiResponse = await response.json()

      if (result.success && result.elements) {
        if (result.elements.length === 0) {
          excalidrawAPI?.updateScene({ elements: [] })
          lastSyncedElementsRef.current = new Map()
          return
        }

        const finalElements = prepareElementsForScene(result.elements, convertToExcalidrawElements as any)

        // Seed known containers BEFORE updateScene so onChange doesn't re-inject titles
        seedKnownContainers(finalElements)

        excalidrawAPI?.updateScene({ elements: finalElements })

        // Populate sync baseline so deletions are detected on next sync
        const baselineMap = new Map<string, ServerElement>()
        for (const el of result.elements) {
          baselineMap.set(el.id, el)
        }
        lastSyncedElementsRef.current = baselineMap
      }

      // Fetch current sync version so delta sync works correctly
      try {
        const versionRes = await fetch('/api/sync/version', { headers: tenantHeaders() })
        const versionData = await versionRes.json()
        if (versionData.success && typeof versionData.syncVersion === 'number') {
          lastSyncVersionRef.current = versionData.syncVersion
          lastReceivedSyncVersionRef.current = versionData.syncVersion
          localStorage.setItem('excalidraw-last-sync-version', String(versionData.syncVersion))
        }
      } catch {}

      // Set hash baseline so auto-sync doesn't immediately re-sync unchanged content
      if (excalidrawAPI) {
        const sceneElements = excalidrawAPI.getSceneElements()
        lastSyncedHashRef.current = computeElementHash(sceneElements)
      }

      // Also load files (image data)
      try {
        const filesRes = await fetch('/api/files', { headers: tenantHeaders() })
        const filesData = await filesRes.json()
        if (filesData.success && filesData.files) {
          const fileValues = Object.values(filesData.files) as any[]
          if (fileValues.length > 0 && excalidrawAPI) {
            excalidrawAPI.addFiles(fileValues)
          }
        }
      } catch {}
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (): void => {
    if (!reconnectEnabledRef.current) {
      return
    }
    if (websocketRef.current &&
        (websocketRef.current.readyState === WebSocket.OPEN ||
         websocketRef.current.readyState === WebSocket.CONNECTING)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    
    websocketRef.current = new WebSocket(wsUrl)
    
    websocketRef.current.onopen = () => {
      setIsConnected(true)
      
      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }
    
    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }
    
    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)
      
      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000 && event.code !== WS_AUTH_CLOSE_CODE && reconnectEnabledRef.current) {
        setTimeout(connectWebSocket, 3000)
      }
    }
    
    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const sendHello = (tenantId?: string): void => {
    const ws = websocketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const message: Record<string, string> = { type: 'hello' }
    if (tenantId) message.tenantId = tenantId
    if (browserApiKey) message.apiKey = browserApiKey
    ws.send(JSON.stringify(message))
  }

  const sendAck = (msgId: string | undefined, status: 'applied' | 'partial' | 'failed', elementCount?: number, expectedCount?: number): void => {
    if (!msgId) return
    const ws = websocketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ack', msgId, status, elementCount, expectedCount }))
  }

  const triggerDeltaResync = async (): Promise<void> => {
    if (isResyncingRef.current) return
    isResyncingRef.current = true
    try {
      const response = await fetch('/api/elements/sync/v2', {
        method: 'POST',
        headers: tenantHeaders(),
        body: JSON.stringify({
          lastSyncVersion: lastReceivedSyncVersionRef.current,
          changes: []
        })
      })
      if (response.ok) {
        const data = await response.json() as {
          currentSyncVersion: number
          serverChanges: { id: string; action: string; element: any; sync_version: number }[]
        }
        const api = excalidrawAPIRef.current
        if (api && data.serverChanges.length > 0) {
          const scene = api.getSceneElements()
          let merged = [...scene]
          for (const sc of data.serverChanges) {
            if (sc.action === 'delete') {
              merged = merged.filter(el => el.id !== sc.id)
            } else if (sc.element) {
              const preparedIncoming = prepareElementsForScene([sc.element], convertToExcalidrawElements as any)
              const incoming = preparedIncoming[0] as any | undefined
              const idx = merged.findIndex(el => el.id === sc.id)
              if (!incoming) {
                continue
              }
              if (idx >= 0) {
                // Merge to preserve local Excalidraw internals needed for point editing.
                merged[idx] = { ...merged[idx], ...incoming } as any
              } else {
                merged.push(...preparedIncoming)
              }
            }
          }
          api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
        }
        lastReceivedSyncVersionRef.current = data.currentSyncVersion
        lastSyncVersionRef.current = data.currentSyncVersion
        localStorage.setItem('excalidraw-last-sync-version', String(data.currentSyncVersion))
        // Update sync baseline so deletion detection works after resync
        if (api) {
          const activeElements = api.getSceneElements().filter(el => !el.isDeleted)
          const baselineMap = new Map<string, any>()
          for (const el of normalizeForBackend(activeElements)) {
            baselineMap.set(el.id, el)
          }
          lastSyncedElementsRef.current = baselineMap
          lastSyncedHashRef.current = computeElementHash(api.getSceneElements())
        }
        console.log(`Delta resync complete: received ${data.serverChanges.length} changes, now at v${data.currentSyncVersion}`)
      }
    } catch (err) {
      console.error('Delta resync failed:', err)
    } finally {
      isResyncingRef.current = false
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    switch (data.type) {
      case 'auth_required':
        sendHello(activeTenantIdRef.current ?? undefined)
        return

      case 'auth_failed':
        reconnectEnabledRef.current = false
        showToast('Authentication failed - check EXCALIDRAW_API_KEY', 4000)
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          websocketRef.current.close(WS_AUTH_CLOSE_CODE, 'Authentication failed')
        }
        return

      case 'error':
        if (typeof data.message === 'string' && data.message) {
          showToast(data.message, 4000)
        }
        return

      case 'project_switched': {
        console.log('Project switched:', data.projectId, data.projectName)
        const api = excalidrawAPIRef.current
        if (!api) return
        api.updateScene({
          elements: [],
          captureUpdate: CaptureUpdateAction.NEVER
        })
        lastSyncedHashRef.current = ''
        lastSyncedElementsRef.current = new Map()
        loadExistingElements()
        return
      }

      case 'tenant_switched': {
        console.log('Tenant switched:', data.tenant)
        if (!data.tenant) return
        const incoming = data.tenant as TenantInfo
        sendHello(incoming.id)
        if (incoming.id !== activeTenantIdRef.current) {
          activeTenantIdRef.current = incoming.id
          setActiveTenant(incoming)
          const api = excalidrawAPIRef.current
          if (!api) return
          api.updateScene({
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          lastSyncedHashRef.current = ''
          loadExistingElements()
        } else {
          setActiveTenant(incoming)
        }
        return
      }

      case 'hello_ack': {
        console.log('Hello acknowledged by server:', data.tenantId, data.projectId)
        if (data.tenant) {
          const incoming = data.tenant as TenantInfo
          activeTenantIdRef.current = incoming.id
          setActiveTenant(incoming)
        } else if (typeof data.tenantId === 'string') {
          activeTenantIdRef.current = data.tenantId
        }
        // Seed active project from hello_ack
        fetchProjects()

        const api = excalidrawAPIRef.current
        if (!api) return

        if (Array.isArray(data.elements) && data.elements.length > 0) {
          const finalElements = prepareElementsForScene(data.elements, convertToExcalidrawElements as any)
          // Seed known containers before updateScene
          seedKnownContainers(finalElements)
          api.updateScene({
            elements: finalElements,
            captureUpdate: CaptureUpdateAction.NEVER
          })
          const helloBaseline = new Map<string, any>()
          for (const el of data.elements) {
            helloBaseline.set(el.id, el)
          }
          lastSyncedElementsRef.current = helloBaseline
        } else if (Array.isArray(data.elements)) {
          api.updateScene({
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          lastSyncedElementsRef.current = new Map()
          lastSyncedHashRef.current = ''
        }
        return
      }
    }

    // Gap detection (Task 12): if a message carries sync_version, check for gaps
    if (data.sync_version !== undefined && typeof data.sync_version === 'number') {
      const expected = lastReceivedSyncVersionRef.current + 1
      if (data.sync_version > expected && lastReceivedSyncVersionRef.current > 0) {
        console.warn(`Sync gap: expected v${expected}, got v${data.sync_version}. Triggering resync.`)
        triggerDeltaResync()
        return // resync will fetch everything including this message's changes
      }
      lastReceivedSyncVersionRef.current = data.sync_version
    }

    const api = excalidrawAPIRef.current
    if (!api) {
      sendAck(data.msgId, 'failed')
      return
    }

    try {
      const currentElements = api.getSceneElements()

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const initFinalElements = prepareElementsForScene(data.elements, convertToExcalidrawElements as any)
            seedKnownContainers(initFinalElements)
            api.updateScene({
              elements: initFinalElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            // Update sync baseline for deletion detection
            const initBaseline = new Map<string, any>()
            for (const el of data.elements) {
              initBaseline.set(el.id, el)
            }
            lastSyncedElementsRef.current = initBaseline
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            const hasBindings = (cleanedNewElement as any).start || (cleanedNewElement as any).end
            if (hasBindings) {
              const allElements = [...currentElements, cleanedNewElement] as any[]
              const convertedAll = convertToExcalidrawElements(allElements, { regenerateIds: false })
              api.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            } else {
              const newElement = convertToExcalidrawElements([cleanedNewElement], { regenerateIds: false })
              const updatedElementsAfterCreate = [...currentElements, ...newElement]
              api.updateScene({
                elements: updatedElementsAfterCreate,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }
            // CaptureUpdateAction.NEVER does not trigger the onChange callback, so
            // title injection (handleCanvasChange) won't fire automatically. Call it
            // explicitly so new container elements get their Title/subtitle text.
            handleCanvasChange()
            const scene = api.getSceneElements()
            const landed = scene.some(s => s.id === data.element!.id)
            sendAck(data.msgId, landed ? 'applied' : 'failed', landed ? 1 : 0, 1)
          }
          break
          
        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            const newLabelText = data.element.label?.text
            const isLabeledContainer = newLabelText !== undefined &&
              ['rectangle', 'ellipse', 'diamond', 'arrow'].includes(data.element.type)
            const isTextElement = data.element.type === 'text'

            let updatedElements: any[]

            if (isLabeledContainer) {
              // Use convertToExcalidrawElements for correct text layout/metrics, but
              // transplant the existing bound text element's ID so Excalidraw's internal
              // state stays coherent (avoids orphan references and text clipping).
              const existingBoundText = currentElements.find(
                el => (el as any).containerId === data.element!.id
              )
              const convertedAll = convertToExcalidrawElements([cleanedUpdatedElement], { regenerateIds: false })
              const convertedContainer = convertedAll[0] as any
              const convertedBoundText = (convertedAll[1] ?? null) as any

              if (existingBoundText && convertedBoundText) {
                // Transplant existing bound text ID so container → text link is stable
                const patchedBoundText = { ...convertedBoundText, id: (existingBoundText as any).id }
                const patchedContainer = {
                  ...convertedContainer,
                  boundElements: [{ id: (existingBoundText as any).id, type: 'text' }]
                }
                updatedElements = [
                  ...currentElements.filter(el => el.id !== data.element!.id && el.id !== (existingBoundText as any).id),
                  patchedContainer,
                  patchedBoundText
                ]
              } else {
                // No existing bound text — use converted result as-is
                updatedElements = [
                  ...currentElements.filter(el => el.id !== data.element!.id && (el as any).containerId !== data.element!.id),
                  ...(convertedBoundText ? [convertedContainer, convertedBoundText] : [convertedContainer])
                ]
              }
            } else if (isTextElement) {
              // For standalone text elements: write label.text into the text field
              const textValue = newLabelText ?? (data.element as any).text ?? ''
              updatedElements = currentElements.map(el =>
                el.id === data.element!.id
                  ? { ...(el as any), ...cleanedUpdatedElement, text: textValue, originalText: textValue }
                  : el
              )
            } else {
              // Generic element (arrows, etc.)
              const preparedUpdated = prepareElementsForScene([data.element], convertToExcalidrawElements as any)
              const nextUpdatedElement = (preparedUpdated[0] ?? cleanedUpdatedElement) as any
              updatedElements = currentElements
                .filter(el => (el as any).containerId !== data.element!.id)
                .map(el => el.id === data.element!.id ? { ...(el as any), ...nextUpdatedElement } : el)
            }

            api.updateScene({
              elements: updatedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            // Update sync baseline so auto-sync doesn't overwrite this WS-applied change
            const wsUpdatedBaseline = new Map(lastSyncedElementsRef.current)
            wsUpdatedBaseline.set(data.element.id, data.element)
            lastSyncedElementsRef.current = wsUpdatedBaseline
            sendAck(data.msgId, 'applied', 1, 1)
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            api.updateScene({
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            // Remove from sync baseline so auto-sync doesn't re-create it
            const wsDeletedBaseline = new Map(lastSyncedElementsRef.current)
            wsDeletedBaseline.delete(data.elementId)
            lastSyncedElementsRef.current = wsDeletedBaseline
            sendAck(data.msgId, 'applied', 1, 1)
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            const hasBoundArrows = cleanedBatchElements.some((el: any) => el.start || el.end)
            if (hasBoundArrows) {
              const allElements = [...currentElements, ...cleanedBatchElements] as any[]
              const convertedAll = convertElementsPreservingImageProps(allElements, convertToExcalidrawElements as any)
              api.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            } else {
              const batchElements = convertElementsPreservingImageProps(cleanedBatchElements, convertToExcalidrawElements as any)
              const updatedElementsAfterBatch = [...currentElements, ...batchElements]
              api.updateScene({
                elements: updatedElementsAfterBatch,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }
            // Verify elements landed in the scene
            const scene = api.getSceneElements()
            const expectedIds = data.elements.map((e: ServerElement) => e.id)
            const landedCount = expectedIds.filter(id => scene.some(s => s.id === id)).length
            const status = landedCount === expectedIds.length ? 'applied' : landedCount > 0 ? 'partial' : 'failed'
            // Update sync baseline so auto-sync doesn't treat these as new local changes
            const wsBatchBaseline = new Map(lastSyncedElementsRef.current)
            for (const el of data.elements) {
              wsBatchBaseline.set(el.id, el)
            }
            lastSyncedElementsRef.current = wsBatchBaseline
            sendAck(data.msgId, status, landedCount, expectedIds.length)
          }
          break
          
        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          break
          
        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break
          
        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          api.updateScene({
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          sendAck(data.msgId, 'applied')
          break

        case 'export_image_request':
          console.log('Received image export request', data)
          if (data.requestId) {
            try {
              // Viewport capture: grab the rendered canvas DOM element directly
              // This captures exactly what the user sees, respecting zoom/scroll.
              if (data.captureViewport && data.format !== 'svg') {
                const canvasEl = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement
                  ?? document.querySelector('canvas') as HTMLCanvasElement
                if (canvasEl) {
                  const dataUrl = canvasEl.toDataURL('image/png')
                  const base64 = dataUrl.split(',')[1]
                  if (base64) {
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                    console.log('Viewport screenshot captured for request', data.requestId)
                    break
                  }
                }
                // Fall through to exportToBlob if canvas capture failed
                console.warn('Viewport canvas capture failed, falling back to exportToBlob')
              }

              const elements = api.getSceneElements()
              const appState = api.getAppState()
              const files = api.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: tenantHeaders(),
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => {})
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: tenantHeaders(),
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => {})
                }
                reader.readAsDataURL(blob)
              }
              console.log('Image export completed for request', data.requestId)
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = api.getSceneElements()
                if (allElements.length > 0) {
                  api.scrollToContent(allElements, { fitToViewport: true, animate: false })
                }
              } else if (data.scrollToElementId) {
                const allElements = api.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  api.scrollToContent([targetElement], { fitToViewport: false, animate: false })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  api.updateScene({ appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => {})
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                api.updateScene({
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  api.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break
          
        case 'files_added':
          if (data.files && typeof data.files === 'object') {
            const fileValues = Object.values(data.files) as any[]
            if (fileValues.length > 0) {
              api.addFiles(fileValues)
            }
          }
          break

        case 'file_deleted':
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Normalize Excalidraw native elements back to MCP format for backend storage.
  // Excalidraw internally splits label text out of containers into separate text
  // elements linked by containerId/boundElements. This causes text to detach on
  // reload because convertToExcalidrawElements doesn't reconstruct that binding.
  // Fix: merge bound text back into container label.text so the backend always
  // stores MCP format that round-trips cleanly.
  const normalizeForBackend = (elements: readonly ExcalidrawElement[]): ServerElement[] => {
    const elementMap = new Map<string, ExcalidrawElement>()
    for (const el of elements) elementMap.set(el.id, el)

    // Collect IDs of text elements that are bound inside a container
    const boundTextIds = new Set<string>()
    // Map containerId → text content for merging
    const containerTextMap = new Map<string, { text: string; fontSize?: number; fontFamily?: number }>()

    for (const el of elements) {
      const cid = (el as any).containerId
      if (el.type === 'text' && cid && elementMap.has(cid)) {
        boundTextIds.add(el.id)
        containerTextMap.set(cid, {
          text: (el as any).text || (el as any).originalText || '',
          fontSize: (el as any).fontSize,
          fontFamily: (el as any).fontFamily,
        })
      }
    }

    const result: ServerElement[] = []
    for (const el of elements) {
      // Keep bound text elements as-is — store native Excalidraw format
      // so x/y/width/height survive round-trips without recalculation
      const out: any = { ...el }

      // Strip label.text from containers that have native bound text,
      // so the load path doesn't double-create text elements
      if (containerTextMap.has(el.id)) {
        delete out.label
      }

      // Normalize arrow bindings from Excalidraw format back to MCP format
      if (el.type === 'arrow') {
        const startBinding = (el as any).startBinding
        const endBinding = (el as any).endBinding
        if (startBinding?.elementId) out.start = { id: startBinding.elementId }
        if (endBinding?.elementId) out.end = { id: endBinding.elementId }
      }

      result.push(out as ServerElement)
    }
    return result
  }

  // Toast message shown briefly in the center of the header
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string, durationMs = 2000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }

  // Fetch list of tenants for the menu
  const fetchTenants = async () => {
    try {
      const res = await fetch('/api/tenants', { headers: tenantHeaders() })
      if (!res.ok) return
      const data = await res.json()
      if (data.success) {
        setTenantList(data.tenants)
      }
    } catch (err) {
      console.error('Failed to fetch tenants:', err)
    }
  }

  // Switch active tenant via API, then reload canvas with new tenant's elements
  const switchTenant = async (tenantId: string) => {
    if (tenantId === activeTenantIdRef.current) {
      setMenuOpen(false)
      return
    }

    try {
      const res = await fetch('/api/tenant/active', {
        method: 'PUT',
        headers: tenantHeaders(),
        body: JSON.stringify({ tenantId })
      })
      if (!res.ok) return

      // Update ref immediately so subsequent fetch uses the new tenant
      activeTenantIdRef.current = tenantId

      // Clear the canvas before loading the new tenant's elements
      excalidrawAPI?.updateScene({
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER
      })
      lastSyncedHashRef.current = ''

      // Update React state (will also re-sync the ref via useEffect, which is fine)
      const tenant = tenantList.find(t => t.id === tenantId)
      if (tenant) setActiveTenant(tenant)

      setMenuOpen(false)

      // Load elements for the newly-active tenant
      const elemRes = await fetch('/api/elements', {
        headers: tenantHeaders({ 'X-Tenant-Id': tenantId })
      })
      const result: ApiResponse = await elemRes.json()
      if (result.success && result.elements && result.elements.length > 0) {
        const switchedElements = prepareElementsForScene(result.elements, convertToExcalidrawElements as any)
        seedKnownContainers(switchedElements)
        excalidrawAPI?.updateScene({ elements: switchedElements })
      }

      showToast('Workspace switched')
    } catch (err) {
      console.error('Failed to switch tenant:', err)
    }
  }

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects', { headers: tenantHeaders() })
      const data = await res.json()
      if (data.success) {
        setProjectList(data.projects)
        const active = data.projects.find((p: any) => p.id === data.activeProjectId)
        if (active) setActiveProject({ id: active.id, name: active.name })
      }
    } catch (err) {
      console.error('Failed to fetch projects:', err)
    }
  }

  const switchProjectUI = async (projectId: string) => {
    if (projectId === activeProject?.id) {
      setProjectMenuOpen(false)
      return
    }
    // Cancel pending timers
    if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null }
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null }
    setSyncCountdown(null)
    // Auto-save current project before switching
    if (excalidrawAPIRef.current && !isSyncingRef.current) {
      const currentElements = excalidrawAPIRef.current.getSceneElements()
      const currentHash = computeElementHash(currentElements)
      if (currentHash !== lastSyncedHashRef.current) {
        await syncToBackend()
      }
    }
    try {
      const res = await fetch('/api/project/active', {
        method: 'PUT',
        headers: tenantHeaders(),
        body: JSON.stringify({ projectId })
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.success) {
        setActiveProject({ id: data.project.id, name: data.project.name })
        setProjectMenuOpen(false)
        // Clear canvas and load the new project's elements directly
        // (don't rely on WS roundtrip which can race)
        const api = excalidrawAPIRef.current
        if (api) {
          api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER })
          lastSyncedHashRef.current = ''
          lastSeenHashRef.current = ''
          lastSyncedElementsRef.current = new Map()
        }
        await loadExistingElements()
        showToast(`Switched to "${data.project.name}"`)
      }
    } catch (err) {
      console.error('Failed to switch project:', err)
    }
  }

  const createProjectUI = async () => {
    const name = newProjectName.trim()
    if (!name) return
    setIsCreatingProject(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: tenantHeaders(),
        body: JSON.stringify({ name })
      })
      const data = await res.json()
      if (data.success) {
        setNewProjectName('')
        await fetchProjects()
        await switchProjectUI(data.project.id)
        showToast(`Project "${name}" created`)
      }
    } catch (err) {
      console.error('Failed to create project:', err)
    } finally {
      setIsCreatingProject(false)
    }
  }

  const deleteProjectUI = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: tenantHeaders()
      })
      const data = await res.json()
      if (data.success) {
        setConfirmDeleteProjectId(null)
        await fetchProjects()
        showToast('Project deleted')
      } else {
        showToast(data.error ?? 'Delete failed', 4000)
        setConfirmDeleteProjectId(null)
      }
    } catch (err) {
      console.error('Failed to delete project:', err)
      setConfirmDeleteProjectId(null)
    }
  }

  const deleteTenantUI = async (tenantId: string) => {
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: 'DELETE',
        headers: tenantHeaders()
      })
      const data = await res.json()
      if (data.success) {
        setConfirmDeleteTenantId(null)
        setTenantList(prev => prev.filter(t => t.id !== tenantId))
        showToast('Workspace deleted')
      } else {
        showToast(data.error ?? 'Delete failed', 4000)
        setConfirmDeleteTenantId(null)
      }
    } catch (err) {
      console.error('Failed to delete tenant:', err)
      setConfirmDeleteTenantId(null)
    }
  }

  const batchDeleteTenants = async () => {
    const ids = Array.from(selectedTenantIds)
    try {
      const res = await fetch('/api/tenants/batch-delete', {
        method: 'POST',
        headers: tenantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ids })
      })
      const data = await res.json()
      const deleted = data.deletedCount ?? 0
      const deletedIds = new Set((data.results ?? []).filter((r: { deleted: boolean }) => r.deleted).map((r: { id: string }) => r.id))
      setTenantList(prev => prev.filter(t => !deletedIds.has(t.id)))
      setSelectedTenantIds(new Set())
      setConfirmBatchDelete(false)
      setBatchSelectMode(false)
      showToast(`${deleted} workspace${deleted !== 1 ? 's' : ''} deleted`)
    } catch (err) {
      console.error('Batch delete failed:', err)
      showToast('Batch delete failed', 4000)
      setConfirmBatchDelete(false)
    }
  }

  const toggleTenantSelection = (id: string) => {
    setSelectedTenantIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const syncToBackend = async (): Promise<void> => {
    if (!excalidrawAPI || isSyncingRef.current) return

    isSyncingRef.current = true
    setSyncStatus('syncing')
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null }
    setSyncCountdown(null)

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const activeElements = currentElements.filter(el => !el.isDeleted)
      const backendElements = normalizeForBackend(activeElements)

      // Compute delta: what changed since last sync
      const changes: { id: string; action: string; element?: any }[] = []
      const currentMap = new Map<string, any>()
      for (const el of backendElements) {
        currentMap.set(el.id, el)
        const prev = lastSyncedElementsRef.current.get(el.id)
        if (!prev || JSON.stringify(prev) !== JSON.stringify(el)) {
          changes.push({ id: el.id, action: 'upsert', element: el })
        }
      }
      // Detect deletions: elements in last sync but not current
      for (const [id] of lastSyncedElementsRef.current) {
        if (!currentMap.has(id)) {
          changes.push({ id, action: 'delete' })
        }
      }

      const response = await fetch('/api/elements/sync/v2', {
        method: 'POST',
        headers: tenantHeaders(),
        body: JSON.stringify({
          lastSyncVersion: lastSyncVersionRef.current,
          changes
        })
      })

      if (response.ok) {
        const result = await response.json() as {
          currentSyncVersion: number
          serverChanges: { id: string; action: string; element: any; sync_version: number }[]
          appliedCount: number
        }

        // Apply server-side changes (MCP-created elements, other tabs' changes)
        if (result.serverChanges.length > 0) {
          const api = excalidrawAPIRef.current
          if (api) {
            const scene = api.getSceneElements()
            let merged = [...scene]
            for (const sc of result.serverChanges) {
              if (sc.action === 'delete') {
                merged = merged.filter(el => el.id !== sc.id)
              } else if (sc.element) {
                const preparedIncoming = prepareElementsForScene([sc.element], convertToExcalidrawElements as any)
                const incoming = preparedIncoming[0] as any | undefined
                const idx = merged.findIndex(el => el.id === sc.id)
                if (!incoming) continue

                if (idx >= 0) {
                  // Existing element: spread-merge to preserve geometry and
                  // Excalidraw internals (seed, version, versionNonce)
                  merged[idx] = { ...merged[idx], ...incoming } as any
                } else {
                  // New element from MCP/other tab: native browser elements pass through,
                  // MCP stubs get converted by prepareElementsForScene.
                  merged.push(...preparedIncoming)
                }
              }
            }
            api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
          }
        }

        // Update tracking state
        lastSyncVersionRef.current = result.currentSyncVersion
        localStorage.setItem('excalidraw-last-sync-version', String(result.currentSyncVersion))
        lastSyncedElementsRef.current = currentMap
        lastSyncedHashRef.current = computeElementHash(currentElements)
        setSyncStatus('idle')
        showToast('Saved')
        console.log(`Delta sync: ${result.appliedCount} applied, ${result.serverChanges.length} received from server`)
      } else {
        setSyncStatus('idle')
        showToast('Sync failed', 3000)
        console.error('Sync failed:', (await response.json() as ApiResponse).error)
      }
    } catch (error) {
      setSyncStatus('idle')
      showToast('Sync failed', 3000)
      console.error('Sync error:', error)
    } finally {
      isSyncingRef.current = false
    }
  }

  // Clear canvas confirmation state (UI button only)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearSkipConfirm, setClearSkipConfirm] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // Load "skip confirm" preference from backend on mount
  useEffect(() => {
    fetch('/api/settings/clear_canvas_skip_confirm', { headers: tenantHeaders() })
      .then(r => r.json())
      .then(data => {
        if (data.value === 'true') setClearSkipConfirm(true)
      })
      .catch(() => {})
  }, [])

  const handleClearCanvasClick = () => {
    if (clearSkipConfirm) {
      performClearCanvas()
    } else {
      setDontAskAgain(false)
      setShowClearConfirm(true)
    }
  }

  const handleClearConfirm = async () => {
    if (dontAskAgain) {
      setClearSkipConfirm(true)
      try {
        await fetch('/api/settings/clear_canvas_skip_confirm', {
          method: 'PUT',
          headers: tenantHeaders(),
          body: JSON.stringify({ value: 'true' })
        })
      } catch {}
    }
    setShowClearConfirm(false)
    performClearCanvas()
  }

  const performClearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        const response = await fetch('/api/elements', { headers: tenantHeaders() })
        const result: ApiResponse = await response.json()
        
        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element => 
            fetch(`/api/elements/${element.id}`, { method: 'DELETE', headers: tenantHeaders() })
          )
          await Promise.all(deletePromises)
        }
        
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <h1>Excalidraw Canvas</h1>
          {activeTenant && (
            <button
              className="tenant-badge-btn"
              onClick={() => {
                setMenuOpen(o => {
                  if (!o) {
                    setTenantSearch('')
                    fetchTenants()
                    setTimeout(() => searchInputRef.current?.focus(), 80)
                  }
                  return !o
                })
              }}
              title="Switch workspace"
            >
              <span className="tenant-label">Workspace:</span> {activeTenant.name} ▾
            </button>
          )}
          {activeProject && (
            <button
              className="tenant-badge-btn project-badge-btn"
              onClick={() => {
                setProjectMenuOpen(o => {
                  if (!o) fetchProjects()
                  return !o
                })
              }}
              title="Switch or create project"
            >
              <span className="tenant-label">Project:</span> {activeProject.name} ▾
            </button>
          )}
        </div>

        {toast && <div className="toast">{toast}</div>}

        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          
          <div className="btn-group">
            <button
              className={`btn-group-item ${syncStatus === 'syncing' ? 'btn-group-busy' : ''}`}
              onClick={syncToBackend}
              disabled={syncStatus === 'syncing' || !excalidrawAPI}
            >
              {syncStatus === 'syncing'
                ? 'Syncing...'
                : syncCountdown !== null
                  ? `Sync in ${syncCountdown}s`
                  : 'Sync'}
            </button>
            <button
              className="btn-group-item"
              onClick={toggleAutoSave}
              title={autoSave ? 'Auto-sync is on — click to turn off' : 'Auto-sync is off — click to turn on'}
            >
              {autoSave ? 'Auto ✓' : 'Auto ✗'}
            </button>
          </div>
          
          <button className="btn-secondary" onClick={handleClearCanvasClick}>Clear Canvas</button>
        </div>
      </div>

      {/* Tenant menu overlay */}
      {menuOpen && (() => {
        const q = tenantSearch.toLowerCase()
        const filtered = q
          ? tenantList.filter(t => t.name.toLowerCase().includes(q) || t.workspace_path.toLowerCase().includes(q))
          : tenantList
        const selectableFiltered = filtered.filter(t => t.id !== activeTenant?.id)
        return (
          <div className="menu-overlay" onClick={() => { setMenuOpen(false); setBatchSelectMode(false); setSelectedTenantIds(new Set()); setConfirmBatchDelete(false) }}>
            <div className="menu-panel" onClick={e => e.stopPropagation()}>
              <div className="menu-header">
                <span>Workspaces</span>
                <button
                  className={`batch-mode-toggle ${batchSelectMode ? 'batch-mode-active' : ''}`}
                  title={batchSelectMode ? 'Exit selection mode' : 'Select workspaces to delete'}
                  onClick={() => {
                    setBatchSelectMode(prev => !prev)
                    setSelectedTenantIds(new Set())
                    setConfirmBatchDelete(false)
                  }}
                >
                  {batchSelectMode ? 'Done' : 'Select'}
                </button>
              </div>
              {batchSelectMode && selectableFiltered.length > 0 && (
                <div className="batch-actions-bar">
                  <button
                    className="batch-action-btn"
                    onClick={() => setSelectedTenantIds(new Set(selectableFiltered.map(t => t.id)))}
                  >Select All</button>
                  <button
                    className="batch-action-btn"
                    onClick={() => setSelectedTenantIds(new Set())}
                  >Unselect All</button>
                  <span className="batch-count">{selectedTenantIds.size} selected</span>
                </div>
              )}
              <div className="menu-search-wrap">
                <input
                  ref={searchInputRef}
                  className="menu-search"
                  type="text"
                  placeholder="Search workspaces..."
                  value={tenantSearch}
                  onChange={e => setTenantSearch(e.target.value)}
                />
              </div>
              <div className="menu-list">
                {filtered.map(t => (
                  <div key={t.id} className="tenant-row">
                    {confirmDeleteTenantId === t.id ? (
                      <div className="project-delete-confirm">
                        <span className="project-delete-msg">Delete "{t.name}"?</span>
                        <button className="project-delete-yes" onClick={() => deleteTenantUI(t.id)}>Delete</button>
                        <button className="project-delete-no" onClick={() => setConfirmDeleteTenantId(null)}>Cancel</button>
                      </div>
                    ) : batchSelectMode ? (
                      <label className={`menu-item batch-item ${activeTenant?.id === t.id ? 'menu-item-active batch-item-disabled' : ''}`}>
                        <input
                          type="checkbox"
                          className="batch-checkbox"
                          disabled={activeTenant?.id === t.id}
                          checked={selectedTenantIds.has(t.id)}
                          onChange={() => toggleTenantSelection(t.id)}
                        />
                        <span className="batch-item-content">
                          <span className="menu-item-name">{t.name}</span>
                          <span className="menu-item-path" title={t.workspace_path}>
                            {t.workspace_path.length > 40
                              ? '...' + t.workspace_path.slice(-37)
                              : t.workspace_path}
                          </span>
                        </span>
                        {activeTenant?.id === t.id && <span className="batch-active-label">active</span>}
                      </label>
                    ) : (
                      <>
                        <button
                          className={`menu-item ${activeTenant?.id === t.id ? 'menu-item-active' : ''}`}
                          onClick={() => switchTenant(t.id)}
                        >
                          <span className="menu-item-name">{t.name}</span>
                          <span className="menu-item-path" title={t.workspace_path}>
                            {t.workspace_path.length > 40
                              ? '...' + t.workspace_path.slice(-37)
                              : t.workspace_path}
                          </span>
                          {activeTenant?.id === t.id && <span className="menu-item-check">✓</span>}
                        </button>
                        {activeTenant?.id !== t.id && (
                          <button
                            className="project-delete-btn"
                            title="Delete workspace"
                            onClick={e => { e.stopPropagation(); setConfirmDeleteTenantId(t.id) }}
                          >×</button>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {filtered.length === 0 && <div className="menu-empty">No matching workspaces</div>}
              </div>
              {batchSelectMode && selectedTenantIds.size > 0 && (
                <div className="batch-delete-bar">
                  {confirmBatchDelete ? (
                    <div className="batch-delete-confirm">
                      <span className="batch-delete-msg">Delete {selectedTenantIds.size} workspace{selectedTenantIds.size !== 1 ? 's' : ''}?</span>
                      <button className="project-delete-yes" onClick={batchDeleteTenants}>Delete</button>
                      <button className="project-delete-no" onClick={() => setConfirmBatchDelete(false)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="batch-delete-btn" onClick={() => setConfirmBatchDelete(true)}>
                      Delete {selectedTenantIds.size} workspace{selectedTenantIds.size !== 1 ? 's' : ''}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Project menu overlay */}
      {projectMenuOpen && (
        <div className="menu-overlay" onClick={() => setProjectMenuOpen(false)}>
          <div className="menu-panel project-menu-panel" onClick={e => e.stopPropagation()}>
            <div className="menu-header">Projects</div>
            <div className="menu-list">
              {projectList.map(p => (
                <div key={p.id} className="project-row">
                  {confirmDeleteProjectId === p.id ? (
                    <div className="project-delete-confirm">
                      <span className="project-delete-msg">Delete "{p.name}"?</span>
                      <button className="project-delete-yes" onClick={() => deleteProjectUI(p.id)}>Delete</button>
                      <button className="project-delete-no" onClick={() => setConfirmDeleteProjectId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <button
                        className={`menu-item project-menu-item ${activeProject?.id === p.id ? 'menu-item-active' : ''}`}
                        onClick={() => switchProjectUI(p.id)}
                      >
                        <span className="menu-item-name">{p.name}</span>
                        {p.description && <span className="menu-item-path">{p.description}</span>}
                        {activeProject?.id === p.id && <span className="menu-item-check">✓</span>}
                      </button>
                      {activeProject?.id !== p.id && projectList.length > 1 && (
                        <button
                          className="project-delete-btn"
                          title="Delete project"
                          onClick={e => { e.stopPropagation(); setConfirmDeleteProjectId(p.id) }}
                        >
                          🗑
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
              {projectList.length === 0 && <div className="menu-empty">No projects yet</div>}
            </div>
            <div className="menu-create-wrap">
              <input
                ref={newProjectInputRef}
                className="menu-search"
                type="text"
                placeholder="New project name..."
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createProjectUI() }}
              />
              <button
                className="menu-create-btn"
                onClick={createProjectUI}
                disabled={!newProjectName.trim() || isCreatingProject}
              >
                {isCreatingProject ? '...' : '+ Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear canvas confirmation modal (UI button only) */}
      {showClearConfirm && (
        <div className="menu-overlay" onClick={() => setShowClearConfirm(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-title">Clear Canvas</div>
            <p className="confirm-msg">This will permanently delete all elements. Continue?</p>
            <label className="confirm-checkbox-label">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={e => setDontAskAgain(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="confirm-actions">
              <button className="btn-secondary" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleClearConfirm}>Clear</button>
            </div>
          </div>
        </div>
      )}

      {/* Draggable font size widget */}
      <div
        className={`custom-font-size-widget${isDragging ? ' dragging' : ''}`}
        style={{ left: widgetPos.x, top: widgetPos.y }}
        onMouseDown={e => {
          // Don't drag when clicking input or button
          if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return
          setIsDragging(true)
          dragOffset.current = { x: e.clientX - widgetPos.x, y: e.clientY - widgetPos.y }
          const onMove = (ev: MouseEvent) => {
            const newPos = { x: ev.clientX - dragOffset.current.x, y: ev.clientY - dragOffset.current.y }
            setWidgetPos(newPos)
          }
          const onUp = () => {
            setIsDragging(false)
            setWidgetPos(prev => {
              localStorage.setItem('font-widget-pos', JSON.stringify(prev))
              return prev
            })
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      >
        <label>Font px</label>
        <input
          type="number"
          min="1"
          max="200"
          placeholder="size"
          value={customFontSize}
          onChange={e => setCustomFontSize(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const size = parseInt(customFontSize, 10)
              if (size > 0) applyCustomFontSize(size)
            }
          }}
        />
        <button onClick={() => {
          const size = parseInt(customFontSize, 10)
          if (size > 0) applyCustomFontSize(size)
        }}>Set</button>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <Excalidraw
          excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
          initialData={{
            elements: [],
            appState: {
              theme: 'dark',
              viewBackgroundColor: '#ffffff'
            }
          }}
          onChange={handleCanvasChange}
        />
      </div>
    </div>
  )
}

export default App
