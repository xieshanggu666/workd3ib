import { defineStore } from 'pinia'
import {
  SCENARIOS, RESOURCE_BASES, EVENT_TYPES, RESOURCE_TYPES, SEVERITY, EVENT_STATUS
} from '@/mock/data'

// 用高德驾车插件视线估算距离与时长（直线 x 路网系数，演示用）
export function roughPath(lng1, lat1, lng2, lat2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  const dist = 2 * R * Math.asin(Math.sqrt(a))
  const roadDist = Math.round(dist * 1.25 * 10) / 10 // 路网折算
  const minutes = Math.round((roadDist / 55) * 60 + 8) // 55km/h 平均 + 装卸
  return { distance: roadDist, minutes }
}

// 灾情等级权重：等级越高、受影响人数越多，分配优先级越高
const SEVERITY_WEIGHT = { red: 4, orange: 3, yellow: 2, blue: 1 }
export function eventPriority(ev) {
  return (SEVERITY_WEIGHT[ev.severity] || 0) * 1e7 + (ev.affected || 0)
}

let planSeq = 0
const nowHM = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

export const useCommandStore = defineStore('command', {
  state: () => ({
    scenarioId: SCENARIOS[0].id,
    events: [],
    bases: [],
    // 派发记录与在途状态
    dispatches: [],
    // 多灾点统筹方案（草稿，提交后锁定库存并批量派发）
    planOpen: false,
    plan: { items: [], generatedAt: '', conflicts: [], notice: '' },
    // 大屏统计
    selectedEventId: null,
    filter: { type: 'all', severity: 'all', status: 'all' },
    search: '',
    autoPlay: false,
    replayTimer: null
  }),

  getters: {
    scenario(state) {
      return SCENARIOS.find((s) => s.id === state.scenarioId)
    },
    filteredEvents(state) {
      let list = [...state.events]
      if (state.filter.type !== 'all') list = list.filter((e) => e.type === state.filter.type)
      if (state.filter.severity !== 'all') list = list.filter((e) => e.severity === state.filter.severity)
      if (state.filter.status !== 'all') list = list.filter((e) => e.status === state.filter.status)
      if (state.search) list = list.filter((e) => e.title.includes(state.search) || (e.location && e.location.name.includes(state.search)))
      return list
    },
    // 各事件已派资源累计（由派发记录聚合，作为需求缺口依据）
    suppliedMap(state) {
      const map = {}
      state.dispatches.forEach((d) => {
        if (!map[d.eventId]) map[d.eventId] = {}
        map[d.eventId][d.type] = (map[d.eventId][d.type] || 0) + d.qty
      })
      return map
    },
    // 各事件需求缺口：{ eventId: [{ type, demand, supplied, gap }] }
    eventGaps() {
      const gaps = {}
      this.events.forEach((ev) => {
        const supplied = this.suppliedMap[ev.id] || {}
        gaps[ev.id] = Object.keys(RESOURCE_TYPES)
          .map((t) => {
            const demand = (ev.demand && ev.demand[t]) || 0
            const sup = supplied[t] || 0
            return { type: t, demand, supplied: sup, gap: Math.max(0, demand - sup) }
          })
          .filter((x) => x.demand > 0 || x.supplied > 0)
      })
      return gaps
    },
    // 方案草稿对库存的占用：{ baseId: { type: qty } }
    planUsage(state) {
      const usage = {}
      state.plan.items.forEach((it) => {
        if (!usage[it.baseId]) usage[it.baseId] = {}
        usage[it.baseId][it.type] = (usage[it.baseId][it.type] || 0) + (Number(it.qty) || 0)
      })
      return usage
    },
    // 方案摘要（覆盖事件数、调拨项、分类合计、最久到达）
    planSummary() {
      const items = this.plan.items
      const byType = {}
      items.forEach((i) => {
        byType[i.type] = (byType[i.type] || 0) + (Number(i.qty) || 0)
      })
      return {
        itemCount: items.length,
        eventCount: new Set(items.map((i) => i.eventId)).size,
        byType,
        maxMinutes: items.reduce((m, i) => Math.max(m, i.minutes || 0), 0)
      }
    },
    // 大屏统计卡片
    stats(state) {
      const counts = { listed: state.events.length }
      SEVERITY.forEach((s) => {
        counts[s.value] = state.events.filter((e) => e.severity === s.value).length
      })
      counts.dispatching = state.events.filter((e) => e.status === 'dispatching').length
      counts.closed = state.events.filter((e) => e.status === 'closed').length
      counts.dispatchedToday = state.dispatches.length
      const totalAffected = state.events.reduce((sum, e) => sum + (e.affected || 0), 0)
      return { ...counts, totalAffected }
    },
    typeLabels() {
      return EVENT_TYPES
    }
  },

  actions: {
    loadScenario(id) {
      this.scenarioId = id
      const s = this.scenario
      this.events = s.events.map((e) => ({
        ...e,
        timeline: [
          { at: e.reportedAt, text: `事件上报：${e.title}` }
        ]
      }))
      this.bases = RESOURCE_BASES.map((b) => ({ ...b, stock: { ...b.stock } }))
      this.dispatches = []
      this.plan = { items: [], generatedAt: '', conflicts: [], notice: '' }
      this.planOpen = false
      this.selectedEventId = this.events[0] ? this.events[0].id : null
    },
    selectEvent(id) {
      this.selectedEventId = id
    },
    // 状态流转到下一步
    advanceStatus(eventId, toStatus) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      const from = EVENT_STATUS.find((s) => s.value === ev.status)
      const to = EVENT_STATUS.find((s) => s.value === toStatus)
      ev.status = toStatus
      ev.timeline.push({ at: nowHM(), text: `状态变更：${from.label} → ${to.label}` })
    },
    // 从资源库派发资源到受灾点
    dispatchResource({ baseId, eventId, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      const ev = this.events.find((e) => e.id === eventId)
      if (!base || !ev) return null
      qty = Math.max(0, Math.min(qty, base.stock[type] || 0))
      if (qty === 0) return null
      base.stock[type] -= qty
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const record = {
        id: 'dp-' + Date.now(),
        baseId, baseName: base.name, eventId, eventTitle: ev.title,
        lng: ev.location.lng, lat: ev.location.lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowHM(),
        color: EVENT_TYPES[ev.type].color
      }
      this.dispatches.unshift(record)
      ev.timeline.push({ at: record.at, text: `派发 ${record.typeLabel} ${qty}${record.unit}👈${base.name}` })
      if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      return record
    },
    withdrawDispatch(recordId) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] += rec.qty
      this.dispatches = this.dispatches.filter((d) => d.id !== recordId)
    },

    /* ---------- 多灾点资源统筹 ---------- */

    openPlan() {
      this.planOpen = true
      if (!this.plan.items.length) this.generatePlan()
    },
    closePlan() {
      this.planOpen = false
    },
    eventPriorityOf(id) {
      const ev = this.events.find((e) => e.id === id)
      return ev ? eventPriority(ev) : 0
    },
    // 按灾情等级、需求缺口、运输时长生成跨基地分配方案
    generatePlan() {
      const reserved = {} // 方案内部预占：{ baseId: { type: qty } }
      const items = []
      const events = this.events
        .filter((e) => e.status !== 'closed')
        .sort((a, b) => eventPriority(b) - eventPriority(a))
      for (const ev of events) {
        const supplied = this.suppliedMap[ev.id] || {}
        // 缺口大的资源类型优先分配
        const needs = Object.keys(RESOURCE_TYPES)
          .map((t) => ({ t, gap: (ev.demand?.[t] || 0) - (supplied[t] || 0) }))
          .filter((x) => x.gap > 0)
          .sort((a, b) => b.gap - a.gap)
        for (const { t, gap } of needs) {
          let remaining = gap
          // 运输时长近的基地优先，库存不足时自动跨基地拆分
          const candidates = this.bases
            .map((b) => ({ b, eta: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.eta.minutes - y.eta.minutes)
          for (const { b, eta } of candidates) {
            if (remaining <= 0) break
            const used = (reserved[b.id] && reserved[b.id][t]) || 0
            const avail = (b.stock[t] || 0) - used
            if (avail <= 0) continue
            const take = Math.min(avail, remaining)
            if (!reserved[b.id]) reserved[b.id] = {}
            reserved[b.id][t] = used + take
            items.push({
              id: 'pi-' + Date.now() + '-' + planSeq++,
              eventId: ev.id, baseId: b.id, type: t, qty: take,
              distance: eta.distance, minutes: eta.minutes
            })
            remaining -= take
          }
        }
      }
      this.plan.items = items
      this.plan.generatedAt = nowHM()
      this.plan.conflicts = []
      this.plan.notice = items.length
        ? `已按灾情等级 / 需求缺口 / 运输时长生成 ${items.length} 项调拨，可人工调整后提交`
        : '当前没有未满足的需求缺口'
    },
    // 人工调整方案项（改基地时重算路线估算）
    updatePlanItem(id, patch) {
      const it = this.plan.items.find((i) => i.id === id)
      if (!it) return
      if (patch.baseId && patch.baseId !== it.baseId) {
        const base = this.bases.find((b) => b.id === patch.baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (base && ev) {
          it.baseId = patch.baseId
          const eta = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
          it.distance = eta.distance
          it.minutes = eta.minutes
        }
      }
      if (patch.qty !== undefined) {
        const q = Math.floor(Number(patch.qty))
        it.qty = Number.isFinite(q) ? Math.max(0, q) : 0
      }
      this.plan.conflicts = []
    },
    removePlanItem(id) {
      this.plan.items = this.plan.items.filter((i) => i.id !== id)
      this.plan.conflicts = []
    },
    // 提交前统一校验：数量有效 + 各基地各类资源合计不超库存
    validatePlan() {
      const conflicts = []
      const invalid = this.plan.items.filter((it) => !Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0)
      if (invalid.length) {
        conflicts.push({ kind: 'invalid', count: invalid.length, itemIds: invalid.map((i) => i.id) })
      }
      Object.entries(this.planUsage).forEach(([baseId, types]) => {
        const base = this.bases.find((b) => b.id === baseId)
        Object.entries(types).forEach(([t, need]) => {
          const stock = base ? base.stock[t] || 0 : 0
          if (need > stock) {
            conflicts.push({
              kind: 'overflow', baseId, baseName: base ? base.name : baseId,
              type: t, typeLabel: RESOURCE_TYPES[t]?.label || t,
              need, stock, overflow: need - stock,
              itemIds: this.plan.items.filter((i) => i.baseId === baseId && i.type === t).map((i) => i.id)
            })
          }
        })
      })
      return conflicts
    },
    // 冲突自动重新分配：高优先级事件保留配额，释放的缺口改派其他有库存的基地
    resolveConflicts() {
      // 1) 清理数量无效的调拨项
      this.plan.items = this.plan.items.filter((it) => Number.isFinite(Number(it.qty)) && Number(it.qty) > 0)
      // 2) 超库存的 (基地, 资源)：按事件优先级保留，超出部分释放为未满足需求
      const overflow = this.validatePlan().filter((c) => c.kind === 'overflow')
      const unmet = []
      overflow.forEach((c) => {
        let budget = c.stock
        const items = this.plan.items
          .filter((it) => it.baseId === c.baseId && it.type === c.type)
          .sort((a, b) => this.eventPriorityOf(b.eventId) - this.eventPriorityOf(a.eventId))
        items.forEach((it) => {
          const take = Math.max(0, Math.min(it.qty, budget))
          if (take < it.qty) unmet.push({ eventId: it.eventId, type: it.type, qty: it.qty - take })
          it.qty = take
          budget -= take
        })
      })
      this.plan.items = this.plan.items.filter((it) => it.qty > 0)
      // 3) 释放出的缺口改派其他基地（运输时长优先，可合并到已有方案项）
      const usageOf = (baseId, type) =>
        this.plan.items
          .filter((i) => i.baseId === baseId && i.type === type)
          .reduce((s, i) => s + i.qty, 0)
      const stillUnmet = []
      unmet.forEach((u) => {
        const ev = this.events.find((e) => e.id === u.eventId)
        if (!ev) { stillUnmet.push(u); return }
        let remaining = u.qty
        const candidates = this.bases
          .map((b) => ({ b, eta: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
          .sort((x, y) => x.eta.minutes - y.eta.minutes)
        for (const { b, eta } of candidates) {
          if (remaining <= 0) break
          const avail = (b.stock[u.type] || 0) - usageOf(b.id, u.type)
          if (avail <= 0) continue
          const take = Math.min(avail, remaining)
          const existing = this.plan.items.find(
            (i) => i.eventId === u.eventId && i.baseId === b.id && i.type === u.type
          )
          if (existing) existing.qty += take
          else {
            this.plan.items.push({
              id: 'pi-' + Date.now() + '-' + planSeq++,
              eventId: ev.id, baseId: b.id, type: u.type, qty: take,
              distance: eta.distance, minutes: eta.minutes
            })
          }
          remaining -= take
        }
        if (remaining > 0) stillUnmet.push({ ...u, qty: remaining })
      })
      this.plan.conflicts = []
      this.plan.notice = stillUnmet.length
        ? `已重新分配冲突资源；仍有 ${stillUnmet.length} 类缺口无可用库存，可人工调整或缩减数量`
        : '冲突已自动重新分配，可再次提交校验'
      return { unmet: stillUnmet }
    },
    // 提交方案：统一校验 → 锁定库存 → 批量派发，联动更新事件/路线/统计
    submitPlan() {
      if (!this.plan.items.length) return { ok: false, reason: 'empty' }
      const conflicts = this.validatePlan()
      if (conflicts.length) {
        this.plan.conflicts = conflicts
        this.plan.notice = '存在库存冲突，请自动重新分配或人工调整后再提交'
        return { ok: false, conflicts }
      }
      const batchId = 'batch-' + Date.now()
      const at = nowHM()
      const records = []
      this.plan.items.forEach((it, idx) => {
        const base = this.bases.find((b) => b.id === it.baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (!base || !ev) return
        base.stock[it.type] -= it.qty // 锁定库存
        const rt = RESOURCE_TYPES[it.type]
        records.push({
          id: 'dp-' + Date.now() + '-' + idx,
          batchId,
          baseId: base.id, baseName: base.name,
          eventId: ev.id, eventTitle: ev.title,
          lng: ev.location.lng, lat: ev.location.lat,
          type: it.type, typeLabel: rt.label, qty: it.qty, unit: rt.unit,
          distance: it.distance, minutes: it.minutes, at,
          color: EVENT_TYPES[ev.type].color
        })
        ev.timeline.push({
          at,
          text: `统筹派发 ${rt.label} ${it.qty}${rt.unit}👈${base.name}（批次 #${String(batchId).slice(-4)}）`
        })
        if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      })
      this.dispatches = records.concat(this.dispatches)
      this.plan = { items: [], generatedAt: '', conflicts: [], notice: '' }
      return { ok: true, count: records.length, batchId }
    },

    // 大屏数据自动刷新（模拟实时数据变化演示）
    startAutoPlay() {
      if (this.autoPlay) return
      this.autoPlay = true
      this.replayTimer = setInterval(() => {
        this.events.forEach((e) => {
          if (e.status !== 'closed' && Math.random() > 0.55) {
            e.affected += Math.floor(Math.random() * 60)
          }
        })
      }, 4000)
    },
    stopAutoPlay() {
      this.autoPlay = false
      clearInterval(this.replayTimer)
    },
    resetResource(eventId) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      // 撤回该事件关联的所有派发
      this.dispatches = this.dispatches.filter((d) => {
        if (d.eventId !== eventId) return true
        const base = this.bases.find((b) => b.id === d.baseId)
        if (base) base.stock[d.type] += d.qty
        return false
      })
    }
  }
})
