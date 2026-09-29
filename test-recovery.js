/* eslint-disable */
// 临时集成测试：在 Node 中模拟 localStorage/window，验证可恢复日志
const ts = require('typescript')
const fs = require('fs')
const path = require('path')
require.extensions['.ts'] = function (module, filename) {
  const src = fs.readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true }
  }).outputText
  module._compile(compiled, filename)
}

// ---- 环境垫片 ----
class LocalStorageShim {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
  get length() { return this.map.size }
  key(i) { return [...this.map.keys()][i] }
}
let storage = new LocalStorageShim()
globalThis.localStorage = storage
globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollY: 0 }

const { WorkbenchService } = require('./src/app/workbench.service.ts')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
function reopen() {
  // 重新“实例化” Angular 服务（绕过注入器直接 new）
  return new WorkbenchService()
}
const SNAP_PREFIX = 'patent-claim-mapping-workbench:v2:snapshot'
const JRNL_PREFIX = 'patent-claim-mapping-workbench:v2:journal'

console.log('\n[1] 首次启动与变更持久化')
{
  storage.clear()
  let svc = reopen()
  assert(storage.getItem(`${SNAP_PREFIX}:a`) || storage.getItem(`${SNAP_PREFIX}:b`), '首次启动写入初始快照')
  svc.addAnnotation(svc.snapshot.features[0].id, '第一条批注')
  svc.addAnnotation(svc.snapshot.features[0].id, '第二条批注')
  assert(svc.snapshot.annotations.length === 4, '两轮修改生效（4 条批注）')
  svc = reopen()
  assert(svc.snapshot.annotations.length === 4, '重开后数据完好')
  assert(!svc.hasPendingRecovery, '正常关闭无恢复提示')
  assert(svc.canUndo, '重开后撤销栈已按日志重建')
  svc.undo()
  assert(svc.snapshot.annotations.length === 3, '重开后可撤销回上一轮')
  assert(svc.canRedo, '撤销后可重做')
  svc.redo()
  assert(svc.snapshot.annotations.length === 4, '重做回到最新')
}

console.log('\n[2] 自动保存中断（日志多出未确认轮次）')
{
  storage.clear()
  let svc = reopen()
  svc.addAnnotation(svc.snapshot.features[0].id, '已确认的批注')
  svc = reopen()
  assert(!svc.hasPendingRecovery, '确认后无待恢复')
  // 制造一轮只写了日志、快照停在上一轮的场景
  svc.addAnnotation(svc.snapshot.features[0].id, '中断的批注')
  const journalEnvelope = JSON.parse(storage.getItem(`${JRNL_PREFIX}:${activeSlot(JRNL_PREFIX)}`))
  const staleSnap = {
    format: 2,
    savedAt: new Date().toISOString(),
    reason: '保存工作位置',
    headSeq: journalEnvelope.entries.length - 1,
    journalMaxSeq: journalEnvelope.entries.length - 1,
    state: journalEnvelope.entries.at(-2).after
  }
  const snapSlot = activeSlot(SNAP_PREFIX)
  storage.setItem(`${SNAP_PREFIX}:${snapSlot === 'a' ? 'b' : 'a'}`, JSON.stringify(staleSnap))
  storage.setItem(`${SNAP_PREFIX}:meta`, JSON.stringify({ active: snapSlot === 'a' ? 'b' : 'a' }))
  svc = reopen()
  assert(svc.hasPendingRecovery, '重开检测到未完成保存')
  // 当前展示的是最后确认版本（不直接吞掉中断轮）
  assert(svc.snapshot.annotations.length === 3, '当前展示最后确认版本（不直接吞掉中断轮）')
  svc.recoverPending(journalEnvelope.entries.at(-1).seq)
  assert(svc.snapshot.annotations.length === 4, '恢复后找回中断轮（4 条批注）')
  assert(svc.canUndo, '恢复后仍可撤销')
  svc.undo()
  assert(svc.snapshot.annotations.length === 3, '恢复后撤销跨过本轮继续')
  assert(svc.canRedo, '恢复后该轮之后可重做')
  svc = reopen()
  assert(!svc.hasPendingRecovery, '恢复确认后重开不再提示')
}
function activeSlot(prefix) {
  try { return JSON.parse(storage.getItem(`${prefix}:meta`)).active } catch { return 'a' }
}

console.log('\n[3] 快照双槽全坏，日志兜底')
{
  storage.clear()
  let svc = reopen()
  svc.addAnnotation(svc.snapshot.features[0].id, '关键批注 X')
  svc.addFeature()
  // 把快照两个槽都写坏
  storage.setItem(`${SNAP_PREFIX}:a`, '{坏半截')
  storage.setItem(`${SNAP_PREFIX}:b`, '也坏了')
  storage.removeItem(`${SNAP_PREFIX}:meta`)
  svc = reopen()
  assert(svc.hasPendingRecovery, '快照损坏时弹出恢复')
  assert(svc.snapshot.claims.length >= 3, '案件内容从日志找回而非空白')
  assert(svc.snapshot.annotations.some(a => a.text === '关键批注 X'), '找回的批注内容正确')
  const rounds = latestPendingRounds(svc)
  svc.recoverPending(rounds[0])
  assert(svc.snapshot.features.length === 7, '找回最新轮（新增的特征也在）')
  svc = reopen()
  assert(!svc.hasPendingRecovery, '另存确认后恢复提示消失')
  assert(storage.getItem(`${SNAP_PREFIX}:a`) || storage.getItem(`${SNAP_PREFIX}:b`), '完好快照已重新落盘')
}

console.log('\n[4] 放弃中断轮次')
{
  storage.clear()
  let svc = reopen()
  svc.addAnnotation(svc.snapshot.features[0].id, '已确认 A')
  const confirmedCount = svc.snapshot.annotations.length
  svc.addAnnotation(svc.snapshot.features[0].id, '未保存 B')
  const j = JSON.parse(storage.getItem(`${JRNL_PREFIX}:${activeSlot(JRNL_PREFIX)}`))
  const stale = {
    format: 2, savedAt: new Date().toISOString(), reason: '保存工作位置',
    headSeq: j.entries.length - 1, journalMaxSeq: j.entries.length - 1,
    state: j.entries.at(-2).after
  }
  const other = activeSlot(SNAP_PREFIX) === 'a' ? 'b' : 'a'
  storage.setItem(`${SNAP_PREFIX}:${other}`, JSON.stringify(stale))
  storage.setItem(`${SNAP_PREFIX}:meta`, JSON.stringify({ active: other }))
  globalThis.window.confirm = () => true
  svc = reopen()
  assert(svc.hasPendingRecovery, '检测到中断')
  svc.discardPending()
  assert(svc.snapshot.annotations.length === confirmedCount, '放弃后回到确认版本')
  assert(!svc.canRedo, '放弃后没有悬空重做')
  const svc2 = reopen()
  assert(!svc2.hasPendingRecovery, '放弃持久化，重开不再提示')
}

console.log('\n[5] 旧格式 v1 自动接入')
{
  storage.clear()
  const legacy = {
    claims: [{ id: 'c9', number: 9, title: '旧案件权利要求', independent: true, text: '旧正文' }],
    paragraphs: [], features: [], annotations: [], orphanMappings: [], versions: [],
    role: 'examiner', currentUserRole: 'examiner', selectedClaimId: 'c9', selectedFeatureId: null, activeTab: 'claim'
  }
  storage.setItem('patent-claim-mapping-workbench-v1', JSON.stringify(legacy))
  let svc = reopen()
  assert(svc.snapshot.claims[0].title === '旧案件权利要求', '旧格式数据已接入')
  assert(svc.snapshot.role === 'examiner', '旧角色保留')
  assert(storage.getItem('patent-claim-mapping-workbench-v1') === null, '接入后删除旧键')
  assert(storage.getItem(`${SNAP_PREFIX}:a`) || storage.getItem(`${SNAP_PREFIX}:b`), '新格式快照已建立')
  svc = reopen()
  assert(svc.snapshot.claims[0].title === '旧案件权利要求', '第二次打开走新格式')
}

console.log('\n[6] 双槽轮换：活动槽损坏自动回退')
{
  storage.clear()
  let svc = reopen()
  svc.addAnnotation(svc.snapshot.features[0].id, '第一版')
  const firstSlot = activeSlot(SNAP_PREFIX)
  svc.addAnnotation(svc.snapshot.features[0].id, '第二版')
  const secondSlot = activeSlot(SNAP_PREFIX)
  assert(firstSlot !== secondSlot, '写入发生槽位轮换')
  // 写坏当前活动槽，应回退到上一槽（第一版），案件不丢
  storage.setItem(`${SNAP_PREFIX}:${secondSlot}`, '###corrupt###')
  svc = reopen()
  assert(svc.snapshot.annotations.some(a => a.text === '第一版'), '活动槽损坏时回退旧槽，案件仍在')
}

console.log('\n[7] 撤销后再编辑，日志分支截断')
{
  storage.clear()
  let svc = reopen()
  svc.addAnnotation(svc.snapshot.features[0].id, 'A')
  svc.addAnnotation(svc.snapshot.features[0].id, 'B')
  svc.undo() // 回到 A
  svc.addAnnotation(svc.snapshot.features[0].id, 'C') // 新分支，旧 B 应截断
  assert(svc.snapshot.annotations.map(a => a.text).includes('C'), '新分支生效')
  assert(!svc.snapshot.annotations.map(a => a.text).includes('B'), '旧重做分支已丢弃')
  svc = reopen()
  assert(!svc.hasPendingRecovery, '重开无误报')
  assert(svc.snapshot.annotations.map(a => a.text).includes('C'), '重开后是新分支')
  assert(svc.canUndo, '仍可撤销')
}

function latestPendingRounds(svc) {
  let rounds = null
  svc.pendingRecovery$.subscribe(p => { rounds = p?.rounds.map(r => r.seq) }).unsubscribe()
  return rounds
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
