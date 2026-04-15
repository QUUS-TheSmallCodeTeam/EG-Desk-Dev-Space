/**
 * Canvas store — entity collection + viewport transform state (ADR-006 §5.1)
 *
 * Implemented with plain React useReducer (no Zustand dep — v1 scope small enough).
 * Exposes a Context provider + hook so child components (Entity, Canvas, Dock) can
 * dispatch actions and read slices without prop drilling.
 */
import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react'
import type {
  CanvasEntity,
  EntityDisplayState,
  EntityLifecycle,
  EntityType,
  EntityTypePropsMap,
  ViewportTransform
} from './types'

// ─── State ──────────────────────────────────────────────────────────
export interface CanvasState {
  entities: CanvasEntity[]
  viewport: ViewportTransform
}

const initialState: CanvasState = {
  entities: [],
  viewport: { x: 0, y: 0, k: 1 }
}

// ─── Actions ────────────────────────────────────────────────────────
export type CanvasAction =
  | { type: 'ADD_ENTITY'; entity: CanvasEntity }
  | { type: 'REMOVE_ENTITY'; id: string }
  | { type: 'UPDATE_ENTITY'; id: string; patch: Partial<CanvasEntity> }
  | { type: 'SET_LIFECYCLE'; id: string; lifecycle: EntityLifecycle; snapshot?: string }
  | { type: 'SET_DISPLAY_STATE'; id: string; displayState: EntityDisplayState }
  | { type: 'TOUCH_ENTITY'; id: string } // update lastActiveAt
  | { type: 'SET_VIEWPORT'; viewport: ViewportTransform }

function reducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case 'ADD_ENTITY':
      return { ...state, entities: [...state.entities, action.entity] }
    case 'REMOVE_ENTITY':
      return { ...state, entities: state.entities.filter((e) => e.id !== action.id) }
    case 'UPDATE_ENTITY':
      return {
        ...state,
        entities: state.entities.map((e) =>
          e.id === action.id ? ({ ...e, ...action.patch } as CanvasEntity) : e
        )
      }
    case 'SET_LIFECYCLE':
      return {
        ...state,
        entities: state.entities.map((e) =>
          e.id === action.id
            ? {
                ...e,
                lifecycle: action.lifecycle,
                snapshot: action.snapshot !== undefined ? action.snapshot : e.snapshot
              }
            : e
        )
      }
    case 'SET_DISPLAY_STATE':
      return {
        ...state,
        entities: state.entities.map((e) =>
          e.id === action.id ? { ...e, displayState: action.displayState } : e
        )
      }
    case 'TOUCH_ENTITY':
      return {
        ...state,
        entities: state.entities.map((e) =>
          e.id === action.id ? { ...e, lastActiveAt: Date.now() } : e
        )
      }
    case 'SET_VIEWPORT':
      return { ...state, viewport: action.viewport }
    default:
      return state
  }
}

// ─── Context ────────────────────────────────────────────────────────
interface CanvasStoreCtx {
  state: CanvasState
  dispatch: Dispatch<CanvasAction>
}

const CanvasStoreContext = createContext<CanvasStoreCtx | null>(null)

export function CanvasStoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  return (
    <CanvasStoreContext.Provider value={{ state, dispatch }}>
      {children}
    </CanvasStoreContext.Provider>
  )
}

export function useCanvasStore(): CanvasStoreCtx {
  const ctx = useContext(CanvasStoreContext)
  if (!ctx) throw new Error('useCanvasStore must be used within CanvasStoreProvider')
  return ctx
}

// ─── Helper: entity factory ─────────────────────────────────────────
let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `entity-${Date.now().toString(36)}-${idCounter}`
}

export function createEntity<T extends EntityType>(
  type: T,
  position: { x: number; y: number },
  typeProps: EntityTypePropsMap[T],
  size: { w: number; h: number } = { w: 280, h: 180 }
): CanvasEntity<T> {
  const now = Date.now()
  return {
    id: nextId(),
    type,
    position,
    size,
    zIndex: 1,
    lifecycle: 'hydrated',
    displayState: 'covered',
    createdAt: now,
    lastActiveAt: now,
    typeProps
  }
}
