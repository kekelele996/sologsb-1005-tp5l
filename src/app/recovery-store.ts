import type {
  Annotation, Claim, ClaimVersion, Feature, JournalAction, JournalEntry, OrphanMapping,
  Paragraph, PendingRecovery, PersistedEnvelope, QuarantineItem, RecoveryJournal,
  RecoverySummary, Role, WorkbenchState
} from './models'

const ENVELOPE_KEY = 'patent-claim-mapping-workbench-v2'
const LEGACY_STATE_KEY = 'patent-claim-mapping-workbench-v1'
const JOURNAL_KEY = 'patent-claim-mapping-recovery-journal-v1'
const BACKUP_KEY = 'patent-claim-mapping-envelope-backup-v1'
const QUARANTINE_INDEX_KEY = 'patent-claim-mapping-quarantine-v1'
const MAX_PERSISTED_HISTORY = 20
const MAX_RECENT = 20

/** 一轮修改的事务数据，由服务层在动栈之后、落盘之前提供。 */
export interface CheckpointData {
  kind: JournalEntry['kind']
  action: string
  before: WorkbenchState
  next: WorkbenchState
  nextPast: WorkbenchState[]
  nextFuture: WorkbenchState[]
  recent: JournalAction[]
}

export interface BootResult {
  state: WorkbenchState
  past: WorkbenchState[]
  future: WorkbenchState[]
  recent: JournalAction[]
  pending: PendingRecovery | null
  savedAt: string | null
}

function roleOf(value: unknown): Role {
  return value === 'examiner' || value === 'viewer' ? value : 'author'
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function coerceClaim(raw: any, index: number): Claim {
  return {
    id: str(raw?.id, `claim-${index}`),
    number: num(raw?.number, index + 1),
    title: str(raw?.title, '未命名权利要求'),
    text: str(raw?.text),
    independent: Boolean(raw?.independent)
  }
}

function coerceParagraph(raw: any, index: number): Paragraph {
  return { id: str(raw?.id, `para-${index}`), section: str(raw?.section, `说明书段落 ${index + 1}`), text: str(raw?.text) }
}

function coerceFeature(raw: any, index: number, claimIds: Set<string>): Feature {
  return {
    id: str(raw?.id, `feature-${index}`),
    claimId: claimIds.has(str(raw?.claimId)) ? str(raw?.claimId) : (claimIds.values().next().value || ''),
    label: str(raw?.label, `特征 ${index + 1}`),
    text: str(raw?.text),
    parentId: typeof raw?.parentId === 'string' ? raw.parentId : null,
    referenceIds: strArray(raw?.referenceIds),
    supportIds: strArray(raw?.supportIds),
    ownerRole: roleOf(raw?.ownerRole)
  }
}

function coerceAnnotation(raw: any, index: number): Annotation {
  return {
    id: str(raw?.id, `annotation-${index}`),
    featureId: str(raw?.featureId),
    authorRole: roleOf(raw?.authorRole),
    authorName: str(raw?.authorName, '未知角色'),
    text: str(raw?.text),
    updatedAt: str(raw?.updatedAt, new Date(0).toISOString())
  }
}

function coerceOrphan(raw: any, index: number): OrphanMapping {
  return {
    id: str(raw?.id, `orphan-${index}`),
    featureLabel: str(raw?.featureLabel, '已删除特征'),
    paragraphId: str(raw?.paragraphId),
    reason: str(raw?.reason, '特征已删除但映射未清理。')
  }
}

function coerceVersion(raw: any, index: number): ClaimVersion {
  return {
    id: str(raw?.id, `version-${index}`),
    name: str(raw?.name, `历史版本 ${index + 1}`),
    createdAt: str(raw?.createdAt, new Date(0).toISOString()),
    claims: Array.isArray(raw?.claims) ? raw.claims.map((item: any, i: number) => coerceClaim(item, i)) : [],
    features: Array.isArray(raw?.features) ? raw.features.map((item: any, i: number) => coerceFeature(item, i, new Set())) : []
  }
}

/** 修正局部损坏：缺字段补默认值、悬空引用剔除，避免“一条坏数据拖垮整案”。 */
export function coerceState(raw: unknown): WorkbenchState {
  if (typeof raw !== 'object' || raw === null) throw new Error('案件数据不是对象')
  const data = raw as Record<string, unknown>
  const claims = Array.isArray(data.claims) ? data.claims.map((item, i) => coerceClaim(item, i)) : []
  if (!claims.length) throw new Error('案件缺少权利要求数据')
  const claimIds = new Set(claims.map(claim => claim.id))
  const paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs.map((item, i) => coerceParagraph(item, i)) : []
  const paragraphIds = new Set(paragraphs.map(paragraph => paragraph.id))
  const features = Array.isArray(data.features) ? data.features.map((item, i) => coerceFeature(item, i, claimIds)) : []
  const featureIds = new Set(features.map(feature => feature.id))
  features.forEach(feature => {
    if (feature.parentId && !featureIds.has(feature.parentId)) feature.parentId = null
    feature.referenceIds = feature.referenceIds.filter(id => featureIds.has(id) && id !== feature.id)
    feature.supportIds = feature.supportIds.filter(id => paragraphIds.has(id))
  })
  const annotations = Array.isArray(data.annotations) ? data.annotations.map((item, i) => coerceAnnotation(item, i)) : []
  const selectedClaimId = claimIds.has(str(data.selectedClaimId)) ? str(data.selectedClaimId) : claims[0].id
  return {
    claims,
    paragraphs,
    features,
    annotations,
    orphanMappings: Array.isArray(data.orphanMappings) ? data.orphanMappings.map((item, i) => coerceOrphan(item, i)) : [],
    versions: Array.isArray(data.versions) ? data.versions.map((item, i) => coerceVersion(item, i)) : [],
    role: roleOf(data.role),
    selectedClaimId,
    selectedFeatureId: features.some(feature => feature.id === data.selectedFeatureId) ? str(data.selectedFeatureId) : null,
    activeTab: str(data.activeTab, 'mapping'),
    currentUserRole: roleOf(data.currentUserRole ?? data.role)
  }
}

export function summarize(state: WorkbenchState): RecoverySummary {
  return {
    claimCount: state.claims.length,
    featureCount: state.features.length,
    mappingCount: state.features.reduce((total, feature) => total + feature.supportIds.length, 0),
    annotationCount: state.annotations.length,
    versionCount: state.versions.length
  }
}

/**
 * 崩溃可恢复的本地存储：
 * 主数据信封（envelope）+ 写前恢复日志（journal）+ 上一代备份（backup）+ 损坏隔离区（quarantine）。
 *
 * 每轮修改的落盘顺序：① journal 写恢复点并读回 → ② 旧信封挪入 backup →
 * ③ 写新信封并读回（信封携带本轮 journalId）→ ④ 闭合 journal。
 * 任意一步被杀掉，重开时 before / next 两份状态都在。
 */
export class RecoveryStore {
  private readonly supported: boolean

  constructor() {
    this.supported = typeof localStorage !== 'undefined'
  }

  get available(): boolean { return this.supported }

  /** 重开工作台：先查日志，再读主数据，必要时接入旧格式或隔离坏数据。 */
  boot(demo: WorkbenchState): BootResult {
    if (!this.supported) return { state: demo, past: [], future: [], recent: [], pending: null, savedAt: null }
    const open = this.readJournal()?.open ?? null
    const envelope = this.readEnvelope(this.rawGet(ENVELOPE_KEY), ENVELOPE_KEY)

    if (envelope) {
      if (!open || envelope.journalId === open.id) {
        if (open) this.closeJournal()
        return { state: envelope.state, past: envelope.past, future: envelope.future, recent: envelope.recent, pending: null, savedAt: envelope.savedAt }
      }
      return {
        state: open.before,
        past: this.deriveBeforePast(open),
        future: this.deriveBeforeFuture(open),
        recent: envelope.recent,
        pending: this.toPending('interrupted', open, envelope.savedAt),
        savedAt: envelope.savedAt
      }
    }

    // 主数据缺失/写坏：备份其次，日志兜底，演示数据最后。
    const backup = this.readEnvelope(this.rawGet(BACKUP_KEY), BACKUP_KEY)
    if (open) {
      return {
        state: open.before,
        past: this.deriveBeforePast(open),
        future: this.deriveBeforeFuture(open),
        recent: open.recent,
        pending: this.toPending('damaged', open, backup?.savedAt ?? null),
        savedAt: backup?.savedAt ?? null
      }
    }
    if (backup) return { state: backup.state, past: backup.past, future: backup.future, recent: backup.recent, pending: null, savedAt: backup.savedAt }

    // 旧格式（v1 裸 WorkbenchState）首次打开自动接入
    const legacyRaw = this.rawGet(LEGACY_STATE_KEY)
    if (legacyRaw !== null) {
      try {
        const state = coerceState(JSON.parse(legacyRaw))
        const recent: JournalAction[] = [{ id: `action-migrate-${Date.now()}`, at: new Date().toISOString(), label: '接入旧版本地数据' }]
        const savedAt = new Date().toISOString()
        this.writeEnvelope({ schema: 2, journalId: '', state, past: [], future: [], recent, savedAt })
        this.safeRemove(LEGACY_STATE_KEY)
        return { state, past: [], future: [], recent, pending: null, savedAt }
      } catch (error) {
        this.quarantine(LEGACY_STATE_KEY, `旧格式数据损坏，无法迁移：${(error as Error).message}`, legacyRaw)
        this.safeRemove(LEGACY_STATE_KEY)
        return { state: demo, past: [], future: [], recent: [], pending: null, savedAt: null }
      }
    }

    return { state: demo, past: [], future: [], recent: [], pending: null, savedAt: null }
  }

  /** 数据修改协议：先写恢复点并读回确认，再写主数据，全部确认后闭合日志。 */
  checkpoint(data: CheckpointData): PersistedEnvelope {
    const entry: JournalEntry = {
      id: `journal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      kind: data.kind,
      action: data.action,
      before: data.before,
      next: data.next,
      nextPast: data.nextPast,
      nextFuture: data.nextFuture,
      recent: data.recent
    }
    this.writeJournal(entry)
    const previousRaw = this.rawGet(ENVELOPE_KEY)
    if (previousRaw !== null) this.bestEffortSet(BACKUP_KEY, previousRaw)
    const written = this.writeEnvelope({
      schema: 2, journalId: entry.id, state: entry.next,
      past: entry.nextPast, future: entry.nextFuture, recent: entry.recent, savedAt: entry.at
    })
    this.closeJournal()
    return written
  }

  /**
   * 纯界面状态（选中项、标签页、角色）不入撤销栈，但同样先留恢复点：
   * 以磁盘上的当前信封为 before，先写日志再覆盖信封。
   */
  snapshot(state: WorkbenchState, past: WorkbenchState[], future: WorkbenchState[], recent: JournalAction[], action = '更新视图状态（选中项 / 标签页 / 角色）'): PersistedEnvelope {
    const current = this.peekEnvelope()
    const entry: JournalEntry = {
      id: `journal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      kind: 'snapshot',
      action,
      before: current?.state ?? state,
      next: state,
      nextPast: past,
      nextFuture: future,
      recent
    }
    this.writeJournal(entry)
    if (current) this.bestEffortSet(BACKUP_KEY, JSON.stringify(current))
    const written = this.writeEnvelope({
      schema: 2, journalId: entry.id, state, past, future, recent, savedAt: entry.at
    })
    this.closeJournal()
    return written
  }

  /** 代理人选择“找回崩溃前进度”：栈从该轮之后继续。 */
  accept(pending: PendingRecovery, recent: JournalAction[]): PersistedEnvelope {
    const open = this.readJournal()?.open
    const now = new Date().toISOString()
    const written = this.writeEnvelope({
      schema: 2,
      journalId: open?.id ?? `accepted-${Date.now()}`,
      state: pending.next,
      past: open ? open.nextPast : [],
      future: open ? open.nextFuture : [],
      recent,
      savedAt: now
    })
    this.closeJournal()
    return written
  }

  /** 代理人选择“放弃崩溃前进度”：沿用上一轮已确认状态，撤销栈回到该轮之前。 */
  discard(pending: PendingRecovery, recent: JournalAction[]): PersistedEnvelope {
    const open = this.readJournal()?.open
    const now = new Date().toISOString()
    const written = this.writeEnvelope({
      schema: 2,
      journalId: `discard-${Date.now()}`,
      state: pending.before,
      past: open ? this.deriveBeforePast(open) : [],
      future: open ? this.deriveBeforeFuture(open) : [],
      recent,
      savedAt: now
    })
    this.closeJournal()
    return written
  }

  listQuarantine(): QuarantineItem[] {
    if (!this.supported) return []
    try {
      const parsed = JSON.parse(this.rawGet(QUARANTINE_INDEX_KEY) || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  getQuarantinePayload(key: string): string | null {
    return this.rawGet(`quarantine-payload:${key}`)
  }

  removeQuarantine(key: string): void {
    if (!this.supported) return
    const items = this.listQuarantine().filter(item => item.key !== key)
    this.bestEffortSet(QUARANTINE_INDEX_KEY, JSON.stringify(items))
    this.safeRemove(`quarantine-payload:${key}`)
  }

  /* ---- 栈回推：放弃某轮时，把该轮对 past/future 的改动反向撤销 ---- */

  private deriveBeforePast(open: JournalEntry): WorkbenchState[] {
    switch (open.kind) {
      case 'commit': return open.nextPast.slice(1)
      case 'undo': return [...open.nextPast, open.next]
      case 'redo': return open.nextPast.slice(0, -1)
      case 'snapshot': return open.nextPast
    }
  }

  private deriveBeforeFuture(open: JournalEntry): WorkbenchState[] {
    switch (open.kind) {
      case 'commit': return []
      case 'undo': return open.nextFuture.slice(0, -1)
      case 'redo': return [open.next, ...open.nextFuture]
      case 'snapshot': return open.nextFuture
    }
  }

  private toPending(reason: PendingRecovery['reason'], open: JournalEntry, savedAt: string | null): PendingRecovery {
    return { reason, action: open.action, journalAt: open.at, savedAt, before: open.before, next: open.next, recent: open.recent }
  }

  private peekEnvelope(): PersistedEnvelope | null {
    const raw = this.rawGet(ENVELOPE_KEY)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed?.schema === 2 ? parsed as PersistedEnvelope : null
    } catch { return null }
  }

  private readJournal(): RecoveryJournal | null {
    const raw = this.rawGet(JOURNAL_KEY)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || parsed.schema !== 1) throw new Error('日志结构无法识别')
      if (parsed.open === null) return { schema: 1, open: null }
      const open = parsed.open as JournalEntry
      coerceState(open.before)
      coerceState(open.next)
      if (typeof open.action !== 'string' || typeof open.at !== 'string') throw new Error('日志缺少轮次信息')
      return { schema: 1, open }
    } catch (error) {
      // 日志自身写坏（仅在日志写入瞬间被杀）：隔离原文，主数据/备份仍可兜底。
      this.quarantine(JOURNAL_KEY, `恢复日志损坏：${(error as Error).message}`, raw)
      this.safeRemove(JOURNAL_KEY)
      return null
    }
  }

  private readEnvelope(raw: string | null, key: string): PersistedEnvelope | null {
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.schema !== 2) throw new Error('主数据版本无法识别')
      const state = coerceState(parsed.state)
      const past = Array.isArray(parsed.past) ? parsed.past.filter((item: unknown) => this.isValidState(item)) : []
      const future = Array.isArray(parsed.future) ? parsed.future.filter((item: unknown) => this.isValidState(item)) : []
      const recent = Array.isArray(parsed.recent)
        ? parsed.recent.filter((item: any) => item && typeof item.id === 'string' && typeof item.at === 'string' && typeof item.label === 'string')
        : []
      return {
        schema: 2,
        journalId: typeof parsed.journalId === 'string' ? parsed.journalId : '',
        state, past, future, recent,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString()
      }
    } catch (error) {
      this.quarantine(key, `主数据损坏：${(error as Error).message}`, raw)
      this.safeRemove(key)
      return null
    }
  }

  private isValidState(item: unknown): boolean {
    try { coerceState(item); return true } catch { return false }
  }

  private writeJournal(entry: JournalEntry): void {
    this.verifiedSet(JOURNAL_KEY, JSON.stringify({ schema: 1, open: entry } satisfies RecoveryJournal))
  }

  private closeJournal(): void {
    this.verifiedSet(JOURNAL_KEY, JSON.stringify({ schema: 1, open: null } satisfies RecoveryJournal))
  }

  private writeEnvelope(envelope: PersistedEnvelope): PersistedEnvelope {
    const trimmed: PersistedEnvelope = {
      ...envelope,
      past: envelope.past.slice(0, MAX_PERSISTED_HISTORY),
      future: envelope.future.slice(0, MAX_PERSISTED_HISTORY),
      recent: envelope.recent.slice(0, MAX_RECENT)
    }
    this.verifiedSet(ENVELOPE_KEY, JSON.stringify(trimmed))
    return trimmed
  }

  /** 安全写入：setItem 捕获配额异常 -> 读回逐字节比对，不一致则视为失败。 */
  private verifiedSet(key: string, raw: string): void {
    try {
      localStorage.setItem(key, raw)
    } catch (error) {
      throw new StorageWriteError(key, error instanceof Error ? error.message : String(error))
    }
    if (localStorage.getItem(key) !== raw) {
      // 写入被静默截断/未生效（隐私模式配额等）：绝不能让当前案件被当成已保存。
      throw new StorageWriteError(key, '写入后读回内容不一致，可能是存储空间不足')
    }
  }

  private bestEffortSet(key: string, raw: string): void {
    try { this.verifiedSet(key, raw) } catch { /* 备份/索引失败不阻塞主流程，日志仍可兜底 */ }
  }

  private rawGet(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  }

  private safeRemove(key: string): void {
    try { localStorage.removeItem(key) } catch { /* 下次写入会覆盖 */ }
  }

  private quarantine(sourceKey: string, reason: string, payload: string): void {
    const item: QuarantineItem = {
      key: `quarantine:${sourceKey}:${Date.now()}`,
      at: new Date().toISOString(),
      reason,
      payload: null
    }
    const items = [item, ...this.listQuarantine()].slice(0, 10)
    // 原文单独存，供代理人导出核对；截断超大载荷避免索引写爆。
    this.bestEffortSet(`quarantine-payload:${item.key}`, payload.slice(0, 500_000))
    this.bestEffortSet(QUARANTINE_INDEX_KEY, JSON.stringify(items))
  }
}

export class StorageWriteError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`本地保存失败（${key}）：${detail}`)
    this.name = 'StorageWriteError'
  }
}
