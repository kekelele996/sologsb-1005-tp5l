import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type { Annotation, Claim, ClaimVersion, Feature, Paragraph, Position, Role, ValidationIssue, WorkbenchState } from './models'
import {
  MIN_CAP,
  summarizeState,
  WorkbenchPersistence,
  type JournalEnvelope,
  type PendingRecovery,
  type RecoveryEntry,
  type RecoverySummary,
  type SnapshotEnvelope
} from './recovery-store'

const POSITION_KEY = 'patent-claim-mapping-position-v1'
const IN_MEMORY_HISTORY_LIMIT = 60

const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]
const initialParagraphs: Paragraph[] = [
  { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }
]
const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]
function demoState(): WorkbenchState {
  return {
    claims: initialClaims, paragraphs: initialParagraphs, features: initialFeatures,
    annotations: initialAnnotations, orphanMappings: [], versions: [],
    role: 'author', currentUserRole: 'author', selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b', activeTab: 'mapping'
  }
}
function clone<T>(value: T): T { return structuredClone(value) }

export interface LastSavedInfo {
  savedAt: string
  reason: string
  /** 磁盘上可恢复的历史轮次数量 */
  recoveryRounds: number
}

interface HistoryFrame {
  state: WorkbenchState
  /** 该状态在编辑链上的位置；0 为链首，null 表示早于磁盘日志保留范围的边界帧 */
  seq: number | null
}

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly persistence = new WorkbenchPersistence()
  private readonly bootInfo = this.bootstrap()
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.bootInfo.state)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private readonly lastSavedSubject = new BehaviorSubject<LastSavedInfo | null>(this.bootInfo.lastSaved)
  private readonly pendingRecoverySubject = new BehaviorSubject<PendingRecovery | null>(this.bootInfo.pendingRecovery)
  private readonly storageWarningSubject = new BehaviorSubject<string | null>(null)
  private readonly migratedLegacySubject = new BehaviorSubject<boolean>(this.bootInfo.migratedLegacy)

  private past: HistoryFrame[] = this.bootInfo.past
  private future: HistoryFrame[] = this.bootInfo.future
  /** 已落盘的恢复日志（成功写入磁盘的部分，空间受限时可能被裁剪） */
  private journalEntries: RecoveryEntry[] = this.bootInfo.journalEntries
  private nextSeq = this.bootInfo.nextSeq
  /** 最新快照确认到的日志轮次位置 */
  private headSeq = this.bootInfo.headSeq
  private journalMaxSeq = this.bootInfo.journalMaxSeq

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly lastSaved$: Observable<LastSavedInfo | null> = this.lastSavedSubject.asObservable()
  readonly pendingRecovery$: Observable<PendingRecovery | null> = this.pendingRecoverySubject.asObservable()
  readonly storageWarning$: Observable<string | null> = this.storageWarningSubject.asObservable()
  readonly migratedLegacy$: Observable<boolean> = this.migratedLegacySubject.asObservable()
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.savePosition())
      // 首次使用（本地没有任何数据）时先落一个空操作快照，保证之后第一次编辑
      // 即便只写了一半，恢复日志仍能找回初始案件
      if (!this.persistence.readSnapshot() && this.journalEntries.length === 0) this.seedInitialSnapshot()
    }
  }

  private seedInitialSnapshot(): void {
    const state = clone(this.stateSubject.value)
    const at = new Date().toISOString()
    this.headSeq = 0
    this.journalMaxSeq = 0
    try {
      this.persistence.writeSnapshot({ format: 2, savedAt: at, reason: '新建案件', headSeq: 0, journalMaxSeq: 0, state })
      this.lastSavedSubject.next({ savedAt: at, reason: '新建案件', recoveryRounds: 0 })
    } catch {
      // 存储被禁用时保持纯内存运行，后续写入仍会尝试
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', () => this.savePosition())
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  get hasPendingRecovery(): boolean { return this.pendingRecoverySubject.value !== null }

  selectClaim(id: string): void {
    this.patchState(state => { state.selectedClaimId = id; state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.commit('切换角色', state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  updateClaim(patch: Partial<Claim>): void {
    this.commit('编辑权利要求', state => {
      const claim = state.claims.find(item => item.id === state.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commit('录入新权利要求', state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-${Date.now()}`, number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('新增说明书段落', state => {
      const next = state.paragraphs.length + 1
      state.paragraphs.push({ id: `para-${Date.now()}`, section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('编辑说明书段落', state => {
      const paragraph = state.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('删除说明书段落', state => {
      state.paragraphs = state.paragraphs.filter(item => item.id !== id)
      state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('新增技术特征', state => {
      const feature: Feature = {
        id: `feature-${Date.now()}`, claimId: state.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === state.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: state.role
      }
      state.features.push(feature)
      state.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('编辑技术特征', state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('删除技术特征', state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: `orphan-${Date.now()}-${paragraphId}`, featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit('更新特征映射', state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commit('清理遗留映射', state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    const names: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }
    this.commit('新增批注', state => state.annotations.push({
      id: `annotation-${Date.now()}`, featureId, authorRole: role, authorName: names[role], text: trimmed, updatedAt: new Date().toISOString()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    this.commit('编辑批注', state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    this.commit('删除批注', state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) state.annotations = state.annotations.filter(item => item.id !== id)
    })
  }

  createVersion(name?: string): void {
    this.commit('保存权利要求版本', state => {
      state.versions.unshift({
        id: `version-${Date.now()}`, name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(state.claims), features: clone(state.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit('恢复历史版本', state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    })
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.unshift({ state: clone(this.stateSubject.value), seq: this.headSeq })
    this.stateSubject.next(previous.state)
    this.headSeq = previous.seq ?? this.headSeq
    this.updateHistory()
    // 只移动快照里的 headSeq 指针，不新增日志轮次
    this.persistSnapshot('撤销操作')
  }

  redo(): void {
    const next = this.future.shift()
    if (!next) return
    this.past.push({ state: clone(this.stateSubject.value), seq: this.headSeq })
    this.stateSubject.next(next.state)
    this.headSeq = next.seq ?? this.headSeq
    this.updateHistory()
    this.persistSnapshot('重做操作')
  }

  /** 恢复某一轮（seq）：该轮之后的修改保留为“重做”，撤销/重做从这轮之后继续。 */
  recoverPending(seq: number): void {
    const pending = this.pendingRecoverySubject.value
    const round = pending?.rounds.find(item => item.seq === seq)
    if (!round) return
    const entry = this.journalEntries.find(item => item.seq === seq)
    if (!entry) return
    const chain = this.reconstructHistory(this.journalEntries, seq, clone(entry.after))
    if (!chain) return
    this.past = chain.past
    this.future = chain.future
    this.stateSubject.next(clone(entry.after))
    this.headSeq = seq
    // 恢复后整段编辑链均已确认，不再重复弹出恢复提示
    this.journalMaxSeq = Math.max(this.journalMaxSeq, ...this.journalEntries.map(item => item.seq))
    this.pendingRecoverySubject.next(null)
    this.updateHistory()
    this.persistSnapshot(`恢复到「${round.reason}」`)
  }

  /** 放弃未保存轮次：回到最后一次确认保存的状态。 */
  discardPending(): void {
    const pending = this.pendingRecoverySubject.value
    if (!pending) return
    if (pending.kind === 'corrupt') {
      // 已保存数据彻底写坏：放弃意味着用空案件重新开始，日志不再可信
      const fresh = demoState()
      this.past = []
      this.future = []
      this.journalEntries = []
      this.nextSeq = 1
      this.headSeq = 0
      this.journalMaxSeq = 0
      this.stateSubject.next(fresh)
      this.pendingRecoverySubject.next(null)
      this.persistence.clearJournal()
      this.updateHistory()
      this.persistSnapshot('放弃损坏数据并新建案件')
      return
    }
    const confirmedSeq = this.journalMaxSeq
    this.journalEntries = this.journalEntries.filter(entry => entry.seq <= confirmedSeq)
    this.persistence.appendJournal(this.journalEntries, this.nextSeq)
    const snapshot = this.persistence.readSnapshot()
    const confirmedEntry = this.journalEntries.find(entry => entry.seq === confirmedSeq)
    const restored = clone(snapshot?.state ?? confirmedEntry?.after ?? demoState())
    const chain = this.reconstructHistory(this.journalEntries, confirmedSeq, restored)
    if (chain) this.past = chain.past
    // 放弃意味着丢弃 head 之后的全部轮次，重做栈必须清空（即使旧日志还没被物理删除）
    this.future = []
    this.headSeq = confirmedSeq
    this.stateSubject.next(restored)
    this.pendingRecoverySubject.next(null)
    this.updateHistory()
    this.persistSnapshot('放弃未保存修改')
  }

  dismissMigrationNotice(): void {
    this.migratedLegacySubject.next(false)
  }

  dismissStorageWarning(): void {
    this.storageWarningSubject.next(null)
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const state = this.stateSubject.value
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    } catch {
      // 位置无法保存不应影响案件数据
    }
    this.persistSnapshot('保存工作位置')
  }

  readPosition(): Position {
    const state = this.stateSubject.value
    const fallback: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try {
      const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null')
      return stored ? { ...fallback, ...stored } : fallback
    } catch {
      return fallback
    }
  }

  exportJson(): string { return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.stateSubject.value) }, null, 2) }

  exportCsv(): string {
    const state = this.stateSubject.value
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => state.paragraphs.find(item => item.id === id)?.section || id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    return issues
  }

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }

  /** 每次数据变更：先在日志里留下本轮“前/后”恢复点，再刷新快照。 */
  private commit(reason: string, recipe: (state: WorkbenchState) => void): void {
    const before = clone(this.stateSubject.value)
    const after = clone(before)
    recipe(after)
    const seq = this.nextSeq++
    const entry: RecoveryEntry = { seq, at: new Date().toISOString(), reason, before, after }

    this.past.push({ state: before, seq: this.headSeq })
    if (this.past.length > IN_MEMORY_HISTORY_LIMIT) this.past.shift()
    this.future = []

    // 1) 恢复点先落盘（即便随后快照写了一半被关，本轮仍可找回）
    //    若此前做过撤销，head 之后的旧分支必须从日志截断，避免重开后混入重做栈
    this.journalEntries = this.journalEntries.filter(entry => entry.seq <= this.headSeq)
    this.journalEntries.push(entry)
    const written = this.persistence.appendJournal(this.journalEntries, this.nextSeq)
    if (written) {
      this.journalEntries = written.entries
      this.journalMaxSeq = written.entries.at(-1)?.seq ?? this.journalMaxSeq
    } else {
      this.journalEntries = this.journalEntries.slice(-MIN_CAP)
      this.notifyStorageFailure()
    }

    // 2) 再写快照并确认
    this.stateSubject.next(after)
    this.headSeq = seq
    this.updateHistory()
    this.persistSnapshot(reason)
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    const next = clone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }

  /**
   * 把恢复日志视为一条“编辑链”：每轮 before 必须与上一轮 after 相同。
   * head 之前的帧构成撤销栈，head 之后（如中断未确认的轮次）构成重做栈。
   * 链在任何位置断裂（旧数据/裁剪/写坏）就只从断点之后重建，绝不串档。
   */
  private reconstructHistory(
    entries: RecoveryEntry[],
    headSeq: number,
    headState: WorkbenchState
  ): { past: HistoryFrame[]; future: HistoryFrame[] } | null {
    const chain = entries.slice().sort((a, b) => a.seq - b.seq)
    const headIndex = chain.findIndex(entry => entry.seq === headSeq)
    if (headIndex === -1) return null
    const headEntry = chain[headIndex]

    // head 状态必须与日志中该轮的 after 一致（或撤销状态下与后一轮的 before 一致）
    const chainHeadState = headEntry.after
    if (JSON.stringify(chainHeadState) !== JSON.stringify(headState)) return null

    // 向前收集连续帧
    const past: HistoryFrame[] = []
    let oldestIndex = headIndex
    let cursor = headEntry.before
    for (let i = headIndex - 1; i >= 0; i--) {
      const entry = chain[i]
      if (JSON.stringify(entry.after) !== JSON.stringify(cursor)) break
      past.unshift({ state: clone(entry.after), seq: entry.seq })
      cursor = entry.before
      oldestIndex = i
    }
    // 栈底：链首之前（seq=0），或日志保留范围之外的边界（最早轮次的前一位置）
    if (oldestIndex === 0) {
      past.unshift({ state: clone(chain[0].before), seq: 0 })
    } else {
      const boundarySeq = chain[oldestIndex].seq - 1
      past.unshift({ state: clone(cursor), seq: boundarySeq })
    }

    // 向后收集可重做帧（要求链连续到 head）
    const future: HistoryFrame[] = []
    let forwardCursor = headEntry.after
    for (let i = headIndex + 1; i < chain.length; i++) {
      const entry = chain[i]
      if (JSON.stringify(entry.before) !== JSON.stringify(forwardCursor)) break
      future.push({ state: clone(entry.after), seq: entry.seq })
      forwardCursor = entry.after
    }
    if (past.length > IN_MEMORY_HISTORY_LIMIT) past.splice(0, past.length - IN_MEMORY_HISTORY_LIMIT)
    return { past, future }
  }

  /** 双槽原子写快照：写坏/写一半都不会覆盖当前已确认案件。 */
  private persistSnapshot(reason: string): void {
    if (typeof localStorage === 'undefined') return
    const envelope: SnapshotEnvelope = {
      format: 2,
      savedAt: new Date().toISOString(),
      reason,
      headSeq: this.headSeq,
      journalMaxSeq: this.journalMaxSeq,
      state: clone(this.stateSubject.value)
    }
    try {
      this.persistence.writeSnapshot(envelope)
      this.lastSavedSubject.next({ savedAt: envelope.savedAt, reason, recoveryRounds: this.journalEntries.length })
    } catch {
      this.notifyStorageFailure()
    }
  }

  private notifyStorageFailure(): void {
    this.storageWarningSubject.next('本地存储空间不足或不可用，自动保存未能完整写入。请立即导出 JSON 备份后清理浏览器存储。')
  }

  // ---------------------------------------------------------------------------
  // 启动恢复
  // ---------------------------------------------------------------------------

  private bootstrap(): {
    state: WorkbenchState
    past: HistoryFrame[]
    future: HistoryFrame[]
    journalEntries: RecoveryEntry[]
    nextSeq: number
    headSeq: number
    journalMaxSeq: number
    lastSaved: LastSavedInfo | null
    pendingRecovery: PendingRecovery | null
    migratedLegacy: boolean
  } {
    if (typeof localStorage === 'undefined') {
      return this.freshBoot()
    }

    // 1) 旧格式（v1）第一次打开自动接入：转成新快照 + 初始恢复点
    const legacy = this.persistence.legacyExists() ? this.persistence.readLegacyState() : null
    const snapshot = this.persistence.readSnapshot()
    if (legacy && !snapshot) {
      const state = clone(legacy)
      const journal: JournalEnvelope = { format: 2, nextSeq: 2, entries: [{ seq: 1, at: new Date().toISOString(), reason: '接入旧版本地数据', before: demoState(), after: state }] }
      try {
        this.persistence.appendJournal(journal.entries, 2)
        this.persistence.writeSnapshot({ format: 2, savedAt: new Date().toISOString(), reason: '旧版本地数据已接入', headSeq: 1, journalMaxSeq: 1, state: clone(state) })
        this.persistence.removeLegacyState()
        return {
          state, past: [{ state: demoState(), seq: 0 }], future: [], journalEntries: journal.entries, nextSeq: 2,
          headSeq: 1, journalMaxSeq: 1,
          lastSaved: { savedAt: new Date().toISOString(), reason: '旧版本地数据已接入', recoveryRounds: 1 },
          pendingRecovery: null, migratedLegacy: true
        }
      } catch {
        // 迁移落盘失败：本次会话仍使用旧数据，但保留 v1 键以便下次重试
        return {
          state, past: [], future: [], journalEntries: [], nextSeq: 1, headSeq: 0, journalMaxSeq: 0,
          lastSaved: null, pendingRecovery: null, migratedLegacy: true
        }
      }
    }
    // 已在 v2 体系下运行后，旧键只作残留清理
    if (snapshot && this.persistence.legacyExists()) this.persistence.removeLegacyState()

    const journal = this.persistence.readJournal()
    const journalEntries = journal.entries
    const nextSeq = journal.nextSeq
    const corrupt = this.persistence.snapshotCorrupt()

    // 2) 没有任何可用数据：演示数据开局
    if (!snapshot) {
      if (corrupt && journalEntries.length) {
        // 快照两个槽都写坏，但恢复日志还在 —— 从日志兜底
        const latest = journalEntries.at(-1)!
        const chain = this.reconstructHistory(journalEntries, latest.seq, clone(latest.after)) ?? { past: [], future: [] }
        return {
          ...this.externalBase(latest.after, chain, journalEntries, nextSeq, latest.seq, latest.seq),
          lastSaved: { savedAt: latest.at, reason: '从恢复日志找回', recoveryRounds: journalEntries.length },
          pendingRecovery: this.buildCorruptRecovery(journalEntries),
          migratedLegacy: false
        }
      }
      return this.freshBoot()
    }

    // 3) 快照可读：按 headSeq 在编辑链上重建撤销/重做
    const headSeq = snapshot.headSeq
    const journalMaxSeq = Math.max(snapshot.journalMaxSeq, journalEntries.at(-1)?.seq ?? 0)
    let built: { past: HistoryFrame[]; future: HistoryFrame[] }
    if (headSeq === 0 && journalEntries.length === 0) {
      built = { past: [], future: [] }
    } else if (headSeq === 0) {
      // 撤销到链首但日志仍在：整条链都是重做
      built = { past: [], future: journalEntries.slice().sort((a, b) => a.seq - b.seq).map(entry => ({ state: clone(entry.after), seq: entry.seq })) }
    } else {
      built = this.reconstructHistory(journalEntries, headSeq, clone(snapshot.state))
        ?? { past: [], future: [] }
    }
    const base = this.externalBase(snapshot.state, built, journalEntries, nextSeq, headSeq, journalMaxSeq)
    const lastSaved: LastSavedInfo = { savedAt: snapshot.savedAt, reason: snapshot.reason, recoveryRounds: journalEntries.length }

    const unconfirmed = journalEntries.filter(entry => entry.seq > snapshot.journalMaxSeq)
    const pendingRecovery = unconfirmed.length
      ? {
        kind: 'interrupted' as const,
        title: '检测到未完成的自动保存',
        detail: '浏览器上次是在自动保存过程中关闭的。最后一次确认保存完好，下面这些修改轮次已在恢复日志中找回，可以恢复或放弃。',
        rounds: unconfirmed.slice().reverse().map(entry => this.roundInfo(entry))
      }
      : null

    return { ...base, lastSaved, pendingRecovery, migratedLegacy: false }
  }

  private externalBase(
    state: WorkbenchState,
    built: { past: HistoryFrame[]; future: HistoryFrame[] },
    journalEntries: RecoveryEntry[],
    nextSeq: number,
    headSeq: number,
    journalMaxSeq: number
  ) {
    return {
      state: clone(state), past: built.past, future: built.future,
      journalEntries, nextSeq, headSeq, journalMaxSeq,
      lastSaved: null as LastSavedInfo | null, pendingRecovery: null as PendingRecovery | null, migratedLegacy: false
    }
  }

  private roundInfo(entry: RecoveryEntry) {
    const summary: RecoverySummary = summarizeState(entry.after, entry.at, entry.reason, entry.seq)
    return { seq: entry.seq, at: entry.at, reason: entry.reason, summary }
  }

  private buildCorruptRecovery(entries: RecoveryEntry[]): PendingRecovery {
    return {
      kind: 'corrupt',
      title: '已保存数据损坏，已从恢复日志找回',
      detail: '本地案件快照未能读取（可能在写入时被关闭或存储被改写）。当前展示的是恢复日志中最新一轮的内容，请确认后保留为新的案件，或放弃后从空案件重新开始。',
      rounds: entries.slice().reverse().map(entry => this.roundInfo(entry))
    }
  }

  private freshBoot() {
    return {
      state: demoState(), past: [] as HistoryFrame[], future: [] as HistoryFrame[],
      journalEntries: [] as RecoveryEntry[], nextSeq: 1, headSeq: 0, journalMaxSeq: 0,
      lastSaved: null, pendingRecovery: null, migratedLegacy: false
    }
  }
}
