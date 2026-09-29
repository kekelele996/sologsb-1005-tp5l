import type { WorkbenchState } from './models'

/**
 * 可恢复本地存储（恢复日志）
 *
 * 两类数据，全部使用“双槽轮换 + 读回校验”的原子写法：
 *  - snapshot：最近一次已确认保存的案件完整状态；
 *  - journal ：每次数据变更前/后的恢复点（恢复日志）。
 *
 * 写入永远先落备用槽、读回校验通过后才切换指针，因此浏览器在自动保存
 * 途中被关闭时，最坏情况只是丢失“最后一轮尚未写完的修改”，上一版完好
 * 的案件状态不会被半截数据覆盖。
 */

export interface RecoveryEntry {
  /** 全局单调递增的轮次号 */
  seq: number
  at: string
  /** 本轮操作的人类可读说明，如“编辑技术特征”“新增批注” */
  reason: string
  /** 变更前的恢复点 */
  before: WorkbenchState
  /** 变更后的状态（崩溃后可找回的内容） */
  after: WorkbenchState
}

export interface SnapshotEnvelope {
  format: 2
  savedAt: string
  reason: string
  /** 当前状态所对应的日志轮次位置（撤销后可能小于某条日志的 seq） */
  headSeq: number
  /** 已确认并入快照的日志最大轮次；日志中超过它的轮次属于中断未确认修改 */
  journalMaxSeq: number
  state: WorkbenchState
}

export interface JournalEnvelope {
  format: 2
  nextSeq: number
  entries: RecoveryEntry[]
}

export interface RecoverySummary {
  at: string
  reason: string
  seq: number
  claims: number
  features: number
  mappings: number
  annotations: number
  versions: number
  claimTitles: string[]
  versionNames: string[]
}

export interface RecoveryRoundInfo {
  seq: number
  at: string
  reason: string
  summary: RecoverySummary
}

export interface PendingRecovery {
  /** interrupted：自动保存中断；corrupt：已保存数据无法读取，靠日志兜底 */
  kind: 'interrupted' | 'corrupt'
  title: string
  detail: string
  /** 可找回的轮次，按时间倒序（最新在前） */
  rounds: RecoveryRoundInfo[]
}

const FORMAT = 2
const META_SUFFIX = 'meta'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 宽容地规整旧版本/半截数据：缺失的集合补空数组，保证案件结构完整。 */
export function normalizeState(raw: unknown): WorkbenchState | null {
  if (!isObject(raw)) return null
  const roles = new Set(['author', 'examiner', 'viewer'])
  const role = roles.has(raw.role as string) ? raw.role as WorkbenchState['role'] : 'author'
  const currentUserRole = roles.has(raw.currentUserRole as string)
    ? raw.currentUserRole as WorkbenchState['currentUserRole']
    : role
  return {
    claims: asArray(raw.claims) as WorkbenchState['claims'],
    paragraphs: asArray(raw.paragraphs) as WorkbenchState['paragraphs'],
    features: asArray(raw.features) as WorkbenchState['features'],
    annotations: asArray(raw.annotations) as WorkbenchState['annotations'],
    orphanMappings: asArray(raw.orphanMappings) as WorkbenchState['orphanMappings'],
    versions: asArray(raw.versions) as WorkbenchState['versions'],
    role,
    currentUserRole,
    selectedClaimId: typeof raw.selectedClaimId === 'string' ? raw.selectedClaimId : '',
    selectedFeatureId: typeof raw.selectedFeatureId === 'string' ? raw.selectedFeatureId : null,
    activeTab: typeof raw.activeTab === 'string' ? raw.activeTab : 'mapping'
  }
}

function isSnapshotEnvelope(raw: unknown): raw is SnapshotEnvelope {
  if (!isObject(raw) || raw.format !== FORMAT || !normalizeState(raw.state)) return false
  return typeof raw.savedAt === 'string' && typeof raw.headSeq === 'number' && typeof raw.journalMaxSeq === 'number'
}

function isJournalEnvelope(raw: unknown): raw is JournalEnvelope {
  if (!isObject(raw) || raw.format !== FORMAT || typeof raw.nextSeq !== 'number') return false
  return asArray(raw.entries).every(entry =>
    isObject(entry) && typeof entry.seq === 'number' && typeof entry.at === 'string'
    && typeof entry.reason === 'string' && !!normalizeState(entry.before) && !!normalizeState(entry.after)
  )
}

interface SlotMeta {
  active: 'a' | 'b'
  at: string
}

/**
 * 双槽轮换存储：write 时先写空闲槽并读回校验，确认无误后再切换 meta 指针；
 * read 在首选槽损坏时自动回退到另一槽。崩溃永远不会同时毁掉两份数据。
 */
class RotatingSlotStore<E> {
  constructor(
    private readonly baseKey: string,
    private readonly guard: (raw: unknown) => raw is E
  ) {}

  read(): E | null {
    const meta = this.readMeta()
    const order: Array<'a' | 'b'> = meta ? [meta.active, meta.active === 'a' ? 'b' : 'a'] : ['a', 'b']
    for (const slot of order) {
      const envelope = this.readSlot(slot)
      if (envelope) return envelope
    }
    return null
  }

  /** 两个槽位都存在内容但没有一个能通过校验 —— 用于识别“数据写坏了”。 */
  isCorrupt(): boolean {
    if (this.read()) return false
    return ['a', 'b'].some(slot => {
      try {
        return localStorage.getItem(`${this.baseKey}:${slot}`) !== null
      } catch {
        return false
      }
    })
  }

  /** 写入备用槽并读回校验，成功后才切换指针；失败抛错且不触碰当前槽。 */
  write(envelope: E): void {
    const meta = this.readMeta()
    const target: 'a' | 'b' = meta?.active === 'a' ? 'b' : 'a'
    const json = JSON.stringify(envelope)
    localStorage.setItem(`${this.baseKey}:${target}`, json)
    const verified = this.readSlot(target)
    if (!verified) throw new Error(`写入校验失败：${this.baseKey}:${target}`)
    const nextMeta: SlotMeta = { active: target, at: new Date().toISOString() }
    localStorage.setItem(`${this.baseKey}:${META_SUFFIX}`, JSON.stringify(nextMeta))
    try {
      localStorage.removeItem(`${this.baseKey}:${target === 'a' ? 'b' : 'a'}`)
    } catch {
      // 旧槽清理失败不影响新数据的正确性
    }
  }

  private readMeta(): SlotMeta | null {
    try {
      const raw = localStorage.getItem(`${this.baseKey}:${META_SUFFIX}`)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (isObject(parsed) && (parsed.active === 'a' || parsed.active === 'b')) {
        return { active: parsed.active, at: typeof parsed.at === 'string' ? parsed.at : '' }
      }
    } catch {
      // 指针损坏时按两槽都尝试处理
    }
    return null
  }

  private readSlot(slot: 'a' | 'b'): E | null {
    try {
      const raw = localStorage.getItem(`${this.baseKey}:${slot}`)
      if (raw === null) return null
      const parsed: unknown = JSON.parse(raw)
      return this.guard(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}

export const LEGACY_STATE_KEY = 'patent-claim-mapping-workbench-v1'
const V2_PREFIX = 'patent-claim-mapping-workbench:v2'

/** 空间不足时依次收缩保留的恢复点轮数，尽量保证最新数据先落盘。 */
const JOURNAL_CAPS = [40, 30, 20, 12, 6]
export const MIN_CAP = JOURNAL_CAPS[JOURNAL_CAPS.length - 1]

export class WorkbenchPersistence {
  private readonly snapshots = new RotatingSlotStore<SnapshotEnvelope>(`${V2_PREFIX}:snapshot`, isSnapshotEnvelope)
  private readonly journals = new RotatingSlotStore<JournalEnvelope>(`${V2_PREFIX}:journal`, isJournalEnvelope)

  readSnapshot(): SnapshotEnvelope | null {
    return this.snapshots.read()
  }

  snapshotCorrupt(): boolean {
    return this.snapshots.isCorrupt()
  }

  readJournal(): JournalEnvelope {
    const journal = this.journals.read()
    if (!journal) return { format: FORMAT, nextSeq: 1, entries: [] }
    const entries = [...journal.entries]
      .filter(entry => !!normalizeState(entry.before) && !!normalizeState(entry.after))
      .sort((a, b) => a.seq - b.seq)
    return { format: FORMAT, nextSeq: Math.max(journal.nextSeq, (entries.at(-1)?.seq ?? 0) + 1), entries }
  }

  writeSnapshot(envelope: SnapshotEnvelope): void {
    this.snapshots.write(envelope)
  }

  /**
   * 追加恢复日志；空间不足时从最旧的恢复点开始丢弃并重试。
   * 返回实际落盘的日志（全部失败时返回 null，调用方需提示用户导出备份）。
   */
  appendJournal(entries: RecoveryEntry[], nextSeq: number): JournalEnvelope | null {
    for (const cap of JOURNAL_CAPS) {
      const candidate = entries.slice(-cap)
      try {
        const envelope: JournalEnvelope = { format: FORMAT, nextSeq, entries: candidate }
        this.journals.write(envelope)
        return envelope
      } catch {
        // 继续尝试更小的容量
      }
    }
    return null
  }

  clearJournal(): void {
    try {
      this.journals.write({ format: FORMAT, nextSeq: 1, entries: [] })
    } catch {
      // 即使清空失败也不阻断恢复/放弃流程
    }
  }

  /** 旧格式（v1，单键直存）数据，第一次打开自动接入。 */
  readLegacyState(): WorkbenchState | null {
    try {
      const raw = localStorage.getItem(LEGACY_STATE_KEY)
      return raw ? normalizeState(JSON.parse(raw)) : null
    } catch {
      return null
    }
  }

  legacyExists(): boolean {
    try {
      return localStorage.getItem(LEGACY_STATE_KEY) !== null
    } catch {
      return false
    }
  }

  /** 迁移快照确认落盘后，删除旧格式键，避免下次重复接入。 */
  removeLegacyState(): void {
    try {
      localStorage.removeItem(LEGACY_STATE_KEY)
    } catch {
      // 删除失败时下次打开会按同一条日志继续，安全
    }
  }
}

export function summarizeState(state: WorkbenchState, at: string, reason: string, seq: number): RecoverySummary {  return {
    at,
    reason,
    seq,
    claims: state.claims.length,
    features: state.features.length,
    mappings: state.features.reduce((total, feature) => total + feature.supportIds.length, 0),
    annotations: state.annotations.length,
    versions: state.versions.length,
    claimTitles: state.claims.slice(0, 4).map(claim => `${claim.number}. ${claim.title}`),
    versionNames: state.versions.slice(0, 3).map(version => version.name)
  }
}
