export type Role = 'author' | 'examiner' | 'viewer'

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

export interface Paragraph {
  id: string
  section: string
  text: string
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  supportIds: string[]
  ownerRole: Role
}

export interface Annotation {
  id: string
  featureId: string
  authorRole: Role
  authorName: string
  text: string
  updatedAt: string
}

export interface OrphanMapping {
  id: string
  featureLabel: string
  paragraphId: string
  reason: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface Position {
  tab: string
  claimId: string
  featureId: string | null
  scrollY: number
}

export interface WorkbenchState {
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  role: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
  currentUserRole: Role
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature'
  featureId?: string
  title: string
  detail: string
}

/** 一轮已完成修改的摘要，用于重开时还原“最后哪轮真的存下来了”。 */
export interface JournalAction {
  id: string
  at: string
  label: string
}

/**
 * 写前恢复点：主数据写入前落盘。
 * before 为上一轮已确认完好的状态，next 为这轮修改后的状态；
 * nextPast / nextFuture 为这轮之后的撤销、重做栈，放弃时按 kind 反推旧栈。
 */
export interface JournalEntry {
  id: string
  at: string
  kind: 'commit' | 'undo' | 'redo' | 'snapshot'
  action: string
  before: WorkbenchState
  next: WorkbenchState
  nextPast: WorkbenchState[]
  nextFuture: WorkbenchState[]
  recent: JournalAction[]
}

/** 恢复日志文件；同一时刻至多有一条未闭合的恢复点。 */
export interface RecoveryJournal {
  schema: 1
  open: JournalEntry | null
}

/** 主数据信封：状态与撤销/重做栈一起落盘。journalId 非空表示信封对应一个未闭合恢复点。 */
export interface PersistedEnvelope {
  schema: 2
  journalId: string
  state: WorkbenchState
  past: WorkbenchState[]
  future: WorkbenchState[]
  recent: JournalAction[]
  savedAt: string
}

export interface RecoverySummary {
  claimCount: number
  featureCount: number
  mappingCount: number
  annotationCount: number
  versionCount: number
}

/** 重开时发现中断保存，等待代理人决定恢复或放弃。 */
export interface PendingRecovery {
  /** interrupted：日志之后主数据未写完或未确认；damaged：主数据已写坏并被隔离 */
  reason: 'interrupted' | 'damaged'
  action: string
  journalAt: string
  savedAt: string | null
  before: WorkbenchState
  next: WorkbenchState
  recent: JournalAction[]
}

export interface QuarantineItem {
  key: string
  at: string
  reason: string
  payload: string | null
}
