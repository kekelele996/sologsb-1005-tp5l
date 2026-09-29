import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type { Annotation, Claim, ClaimVersion, Feature, JournalAction, Paragraph, PendingRecovery, Position, QuarantineItem, Role, ValidationIssue, WorkbenchState } from './models'
import { RecoveryStore, StorageWriteError, summarize } from './recovery-store'

const POSITION_KEY = 'patent-claim-mapping-position-v1'
const MAX_HISTORY = 60

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
function sameState(a: WorkbenchState, b: WorkbenchState): boolean { return JSON.stringify(a) === JSON.stringify(b) }

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly store = new RecoveryStore()
  private readonly booted = this.store.boot(demoState())
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.booted.state)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private readonly pendingRecoverySubject = new BehaviorSubject<PendingRecovery | null>(this.booted.pending)
  private readonly saveErrorSubject = new BehaviorSubject<string | null>(null)
  private readonly savedAtSubject = new BehaviorSubject<string | null>(this.booted.savedAt)
  private past: WorkbenchState[] = this.booted.past
  private future: WorkbenchState[] = this.booted.future
  private recent: JournalAction[] = this.booted.recent

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly pendingRecovery$: Observable<PendingRecovery | null> = this.pendingRecoverySubject.asObservable()
  readonly saveError$ = this.saveErrorSubject.asObservable()
  readonly savedAt$ = this.savedAtSubject.asObservable()
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  private readonly beforeUnloadHandler = (): void => {
    this.savePosition()
    if (this.saveErrorSubject.value) this.retrySave()
  }

  constructor() {
    this.updateHistory()
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.beforeUnloadHandler)
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.beforeUnloadHandler)
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  get pendingRecovery(): PendingRecovery | null { return this.pendingRecoverySubject.value }

  selectClaim(id: string): void {
    this.patchState(state => { state.selectedClaimId = id; state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  updateClaim(patch: Partial<Claim>): void {
    this.commit('编辑权利要求正文', state => {
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
    this.commit('调整特征支持映射', state => {
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
    this.commit('保存版本快照', state => {
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
    const previous = this.past[this.past.length - 1]
    if (!previous) return
    const current = clone(this.stateSubject.value)
    const label = this.recent[0]?.label ? `撤销：${this.recent[0].label}` : '撤销上一轮操作'
    const nextPast = this.past.slice(0, -1)
    const nextFuture = [...this.future, current]
    this.runCheckpoint('undo', label, current, previous, nextPast, nextFuture)
  }

  redo(): void {
    const next = this.future[this.future.length - 1]
    if (!next) return
    const current = clone(this.stateSubject.value)
    const label = this.recent[0]?.label ? `重做：${this.recent[0].label}` : '重做上一轮操作'
    const nextPast = [...this.past, current]
    const nextFuture = this.future.slice(0, -1)
    this.runCheckpoint('redo', label, current, next, nextPast, nextFuture)
  }

  /** 重开时对未闭合恢复点作出决定：找回崩溃前进度，或放弃并回到上次完好状态。 */
  resolveRecovery(mode: 'accept' | 'discard'): void {
    const pending = this.pendingRecoverySubject.value
    if (!pending) return
    const resolution: JournalAction = {
      id: `action-${mode}-${Date.now()}`,
      at: new Date().toISOString(),
      label: mode === 'accept' ? `找回中断前进度：${pending.action}` : `放弃中断轮次：${pending.action}`
    }
    try {
      const recent = [resolution, ...(mode === 'accept' ? pending.recent : this.recent)].slice(0, 20)
      const envelope = mode === 'accept'
        ? this.store.accept(pending, recent)
        : this.store.discard(pending, recent)
      this.past = envelope.past
      this.future = envelope.future
      this.recent = envelope.recent
      this.stateSubject.next(clone(envelope.state))
      this.savedAtSubject.next(envelope.savedAt)
      this.saveErrorSubject.next(null)
      this.pendingRecoverySubject.next(null)
      this.updateHistory()
    } catch (error) {
      this.saveErrorSubject.next(this.describeError(error))
    }
  }

  /** 保存失败（如配额不足）后手动补存；恢复点协议保证不会产生半截数据。 */
  retrySave(): void {
    if (!this.saveErrorSubject.value || this.pendingRecoverySubject.value) return
    try {
      const envelope = this.store.snapshot(
        this.stateSubject.value,
        this.past.slice(-20),
        this.future.slice(-20),
        this.recent,
        '补存尚未落盘的修改'
      )
      this.savedAtSubject.next(envelope.savedAt)
      this.saveErrorSubject.next(null)
    } catch (error) {
      this.saveErrorSubject.next(this.describeError(error))
    }
  }

  listQuarantine(): QuarantineItem[] { return this.store.listQuarantine() }
  quarantinePayload(key: string): string | null { return this.store.getQuarantinePayload(key) }
  removeQuarantine(key: string): void { this.store.removeQuarantine(key) }

  /** 恢复弹窗中对比两份状态将找回的内容数量。 */
  compareRecovery(pending: PendingRecovery): { before: ReturnType<typeof summarize>; next: ReturnType<typeof summarize> } {
    return { before: summarize(pending.before), next: summarize(pending.next) }
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const state = this.stateSubject.value
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* 位置丢失不影响案件数据 */ }
  }

  readPosition(): Position {
    const fallback: Position = { tab: this.stateSubject.value.activeTab, claimId: this.stateSubject.value.selectedClaimId, featureId: this.stateSubject.value.selectedFeatureId, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try {
      const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}')
      return {
        tab: typeof stored.tab === 'string' ? stored.tab : fallback.tab,
        claimId: typeof stored.claimId === 'string' ? stored.claimId : fallback.claimId,
        featureId: typeof stored.featureId === 'string' ? stored.featureId : fallback.featureId,
        scrollY: typeof stored.scrollY === 'number' ? stored.scrollY : 0
      }
    } catch { return fallback }
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

  private commit(label: string, recipe: (state: WorkbenchState) => void): void {
    const current = clone(this.stateSubject.value)
    const next = clone(current)
    recipe(next)
    if (sameState(current, next)) return
    const action: JournalAction = { id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), label }
    const nextPast = [...this.past, current].slice(-MAX_HISTORY)
    const recent = [action, ...this.recent].slice(0, 20)
    this.runCheckpoint('commit', label, current, next, nextPast, [], recent, action)
  }

  /**
   * 执行一轮修改事务：先在内存应用，再走“恢复点 → 主数据 → 闭合”协议。
   * 落盘失败时内存修改保留，错误横幅提示重试；恢复点已在磁盘上，重开同样可以找回。
   */
  private runCheckpoint(
    kind: 'commit' | 'undo' | 'redo',
    label: string,
    before: WorkbenchState,
    next: WorkbenchState,
    nextPast: WorkbenchState[],
    nextFuture: WorkbenchState[],
    recent?: JournalAction[],
    action?: JournalAction
  ): void {
    const targetRecent = recent ?? this.recent
    try {
      const envelope = this.store.checkpoint({
        kind, action: label, before, next,
        nextPast: nextPast.slice(-20), nextFuture: nextFuture.slice(-20), recent: targetRecent
      })
      this.past = nextPast
      this.future = nextFuture
      if (action || recent) this.recent = targetRecent
      this.stateSubject.next(next)
      this.savedAtSubject.next(envelope.savedAt)
      this.saveErrorSubject.next(null)
      this.updateHistory()
    } catch (error) {
      // 即便主数据没写成，恢复点可能已落盘；内存照常应用，保证代理人不丢正在编辑的内容。
      this.past = nextPast
      this.future = nextFuture
      if (action || recent) this.recent = targetRecent
      this.stateSubject.next(next)
      this.failSave(error)
    }
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    const next = clone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
    try {
      const envelope = this.store.snapshot(next, this.past.slice(-20), this.future.slice(-20), this.recent)
      this.savedAtSubject.next(envelope.savedAt)
      this.saveErrorSubject.next(null)
    } catch (error) {
      this.failSave(error)
    }
  }

  private failSave(error: unknown): void {
    this.saveErrorSubject.next(this.describeError(error))
    this.updateHistory()
  }

  private describeError(error: unknown): string {
    if (error instanceof StorageWriteError) return error.message
    if (error instanceof Error) return `本地保存失败：${error.message}`
    return '本地保存失败，请检查浏览器存储空间后重试。'
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }
}
