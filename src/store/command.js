import { defineStore } from 'pinia'
import {
  SCENARIOS, RESOURCE_BASES, EVENT_TYPES, RESOURCE_TYPES, SEVERITY, EVENT_STATUS
} from '@/mock/data'

// 用高德驾车插件视线估算距离与时长（直线 x 路网系数，演示用）
function roughPath(lng1, lat1, lng2, lat2) {
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

export const useCommandStore = defineStore('command', {
  state: () => ({
    scenarioId: SCENARIOS[0].id,
    events: [],
    bases: [],
    // 派发记录与在途状态
    dispatches: [],
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
      ev.timeline.push({ at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), text: `状态变更：${from.label} → ${to.label}` })
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
        distance: path.distance, minutes: path.minutes, at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
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