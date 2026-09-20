<template>
  <div v-if="store.planOpen" class="overlay" @click.self="store.closePlan()">
    <div class="panel">
      <!-- 头部 -->
      <header class="p-head">
        <div class="p-title">
          <strong>🧠 多灾点资源统筹</strong>
          <span class="p-sub">按灾情等级 · 需求缺口 · 运输时长生成跨基地分配方案</span>
        </div>
        <div class="p-actions">
          <button class="btn" @click="store.generatePlan()">🔄 重新生成方案</button>
          <button class="btn primary" :disabled="!items.length" @click="onSubmit">✅ 校验并批量派发</button>
          <button class="btn ghost" title="关闭" @click="store.closePlan()">✕</button>
        </div>
      </header>

      <!-- 方案摘要 -->
      <div v-if="items.length" class="p-summary">
        <div class="s-chip">覆盖事件 <b>{{ summary.eventCount }}</b></div>
        <div class="s-chip">调拨项 <b>{{ summary.itemCount }}</b></div>
        <div class="s-chip" v-for="(q, t) in summary.byType" :key="t">
          {{ resIcon(t) }} {{ resLabel(t) }} <b>{{ q }}</b>
        </div>
        <div class="s-chip">最久到达 <b>{{ summary.maxMinutes }}</b> min</div>
        <div class="s-chip dim" v-if="store.plan.generatedAt">生成于 {{ store.plan.generatedAt }}</div>
      </div>

      <!-- 冲突提示 + 自动重分配 -->
      <div v-if="conflicts.length" class="conflict">
        <div class="c-head">⚠ 提交校验发现 {{ conflicts.length }} 处冲突，库存未锁定，请处理后重新提交</div>
        <div class="c-item" v-for="(c, i) in conflicts" :key="i">
          <template v-if="c.kind === 'overflow'">
            【{{ c.baseName }}】{{ c.typeLabel }} 需求 {{ c.need }} / 库存 {{ c.stock }}，超出 {{ c.overflow }}
          </template>
          <template v-else>存在 {{ c.count }} 项数量无效的调拨（需大于 0）</template>
        </div>
        <button class="btn warn" @click="onResolve">⚡ 自动重新分配</button>
      </div>
      <div v-if="store.plan.notice && !conflicts.length" class="notice">{{ store.plan.notice }}</div>

      <!-- 方案明细（按事件分组，可人工调整） -->
      <div v-if="groups.length" class="p-body">
        <div v-for="g in groups" :key="g.event.id" class="ev-group">
          <div class="ev-head">
            <span class="sev" :style="{ background: severityColor(g.event.severity) }">{{ severityLabel(g.event.severity) }}</span>
            <strong>{{ g.event.title }}</strong>
            <span class="gap-chips">
              <span v-for="x in gapsOf(g.event.id)" :key="x.type" class="gap-chip">
                缺 {{ resLabel(x.type) }} {{ x.gap }}
              </span>
            </span>
          </div>
          <div class="row head">
            <span class="c-type">资源</span>
            <span class="c-base">调出基地（余量 · 运输时长）</span>
            <span class="c-qty">数量</span>
            <span class="c-eta">路线估算</span>
            <span class="c-op"></span>
          </div>
          <div class="row" v-for="it in g.items" :key="it.id">
            <span class="c-type">{{ resIcon(it.type) }} {{ resLabel(it.type) }}</span>
            <select
              class="c-base"
              :value="it.baseId"
              @change="store.updatePlanItem(it.id, { baseId: $event.target.value })"
            >
              <option
                v-for="opt in baseOptions(it)"
                :key="opt.id"
                :value="opt.id"
                :disabled="opt.avail <= 0 && opt.id !== it.baseId"
              >{{ opt.name }}（余 {{ opt.avail }} · {{ opt.minutes }}min）</option>
            </select>
            <span class="c-qty">
              <input
                type="number" min="0"
                :value="it.qty"
                @change="store.updatePlanItem(it.id, { qty: $event.target.value })"
              />
              <em>{{ resUnit(it.type) }}</em>
            </span>
            <span class="c-eta">{{ it.distance }}km · 约{{ it.minutes }}min</span>
            <span class="c-op"><button class="del" title="移除" @click="store.removePlanItem(it.id)">🗑</button></span>
          </div>
        </div>
      </div>
      <div v-else class="p-empty">
        <div class="e-icon">📦</div>
        <p>暂无调拨方案，点击「重新生成方案」按灾情等级、需求缺口与运输时长自动统筹。</p>
      </div>

      <footer class="p-foot">
        提交时统一校验并锁定库存；冲突可一键重新分配；派发后联动更新事件状态、运输路线与统计。
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCommandStore, eventPriority, roughPath } from '@/store/command'
import { RESOURCE_TYPES, SEVERITY } from '@/mock/data'

const store = useCommandStore()

const items = computed(() => store.plan.items)
const conflicts = computed(() => store.plan.conflicts)
const summary = computed(() => store.planSummary)

const resLabel = (t) => RESOURCE_TYPES[t]?.label || t
const resIcon = (t) => RESOURCE_TYPES[t]?.icon || ''
const resUnit = (t) => RESOURCE_TYPES[t]?.unit || ''
const severityColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const severityLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s

// 方案项按事件分组，组间按事件优先级（灾情等级 + 受影响人数）排序
const groups = computed(() => {
  const byEvent = {}
  store.plan.items.forEach((it) => {
    if (!byEvent[it.eventId]) byEvent[it.eventId] = []
    byEvent[it.eventId].push(it)
  })
  return Object.keys(byEvent)
    .map((eid) => ({ event: store.events.find((e) => e.id === eid), items: byEvent[eid] }))
    .filter((g) => g.event)
    .sort((a, b) => eventPriority(b.event) - eventPriority(a.event))
})

// 事件剩余缺口（随已派数量实时变化）
const gapsOf = (eventId) => (store.eventGaps[eventId] || []).filter((x) => x.gap > 0)

// 基地下拉选项：余量 = 库存 - 方案中其他项占用，按运输时长排序
function baseOptions(item) {
  const ev = store.events.find((e) => e.id === item.eventId)
  if (!ev) return []
  return store.bases
    .map((b) => {
      const usedByOthers = store.plan.items
        .filter((i) => i.id !== item.id && i.baseId === b.id && i.type === item.type)
        .reduce((s, i) => s + (Number(i.qty) || 0), 0)
      const eta = roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat)
      return {
        id: b.id,
        name: b.name,
        avail: Math.max(0, (b.stock[item.type] || 0) - usedByOthers),
        minutes: eta.minutes
      }
    })
    .sort((a, b) => a.minutes - b.minutes)
}

function onSubmit() {
  const res = store.submitPlan()
  if (res.ok) store.closePlan()
  // 冲突已由 submitPlan 写入 store.plan.conflicts，横幅自动展示
}

function onResolve() {
  store.resolveConflicts()
}
</script>

<style scoped>
.overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(4, 8, 18, 0.62);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.panel {
  width: min(980px, 94vw); max-height: 88vh;
  display: flex; flex-direction: column;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.25);
  border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,0.55);
  overflow: hidden;
}

.p-head {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid rgba(120,160,220,0.15);
  background: linear-gradient(90deg, #101d39, #14264a);
}
.p-title { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.p-title strong { color: #fff; font-size: 15px; }
.p-sub { font-size: 11px; color: #6f8cb8; }
.p-actions { display: flex; gap: 8px; }
.btn {
  background: #16263f; border: 1px solid rgba(120,160,220,0.25);
  color: #9db1d4; padding: 7px 13px; border-radius: 7px;
  font-size: 12px; cursor: pointer; transition: all 0.18s;
}
.btn:hover:not(:disabled) { border-color: #4d8dff; color: #fff; }
.btn.primary {
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; border-color: transparent; font-weight: 600;
}
.btn.primary:hover:not(:disabled) { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(41,98,255,0.4); }
.btn.primary:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }
.btn.ghost { padding: 7px 10px; }
.btn.warn {
  margin-top: 8px;
  background: rgba(255,152,0,0.14); border: 1px solid rgba(255,152,0,0.5); color: #ffb74d;
}
.btn.warn:hover { background: rgba(255,152,0,0.24); border-color: #ff9800; color: #ffe0b2; }

.p-summary {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 10px 16px; border-bottom: 1px solid rgba(120,160,220,0.12);
}
.s-chip {
  font-size: 11px; color: #8ba2c8;
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  padding: 4px 10px; border-radius: 6px;
}
.s-chip b { color: #ffc107; font-size: 13px; }
.s-chip.dim { color: #5b6f94; margin-left: auto; }

.conflict {
  margin: 10px 16px 0; padding: 10px 12px;
  background: rgba(239,83,80,0.1); border: 1px solid rgba(239,83,80,0.4);
  border-radius: 9px; font-size: 12px; color: #ef9a9a;
}
.c-head { font-weight: 700; color: #ef5350; margin-bottom: 6px; }
.c-item { padding: 2px 0; color: #e8a0a0; }
.notice {
  margin: 10px 16px 0; padding: 8px 12px;
  background: rgba(77,141,255,0.1); border: 1px solid rgba(77,141,255,0.3);
  border-radius: 8px; font-size: 12px; color: #9db8e8;
}

.p-body { flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 0; }
.p-body::-webkit-scrollbar { width: 6px; }
.p-body::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }

.ev-group {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.14);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 12px;
}
.ev-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.sev { color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
.ev-head strong { color: #e8eefb; font-size: 13px; }
.gap-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-left: auto; }
.gap-chip {
  font-size: 10px; color: #ffb74d;
  background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3);
  padding: 1px 7px; border-radius: 4px;
}

.row {
  display: grid;
  grid-template-columns: 110px 1fr 130px 130px 34px;
  gap: 8px; align-items: center;
  padding: 5px 0; font-size: 12px; color: #c6d2e6;
  border-top: 1px dashed rgba(120,160,220,0.1);
}
.row.head {
  color: #5b6f94; font-size: 10px; padding: 4px 0;
  border-top: none;
}
.c-type { color: #dbe4f3; }
.row.head .c-type, .row.head .c-base, .row.head .c-qty, .row.head .c-eta { color: #5b6f94; }
.c-base {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px 8px; font-size: 11px;
  width: 100%; box-sizing: border-box;
}
.c-qty { display: flex; align-items: center; gap: 4px; }
.c-qty input {
  width: 76px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #ffc107; border-radius: 6px; padding: 6px 8px; font-size: 12px;
  box-sizing: border-box;
}
.c-qty em { font-style: normal; color: #5b6f94; font-size: 11px; }
.c-eta { color: #8ba2c8; font-size: 11px; }
.c-op { text-align: center; }
.del {
  background: transparent; border: none; cursor: pointer;
  font-size: 13px; opacity: 0.6; transition: opacity 0.15s;
}
.del:hover { opacity: 1; }

.p-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  color: #5b6f94; padding: 40px 20px; text-align: center;
}
.e-icon { font-size: 42px; margin-bottom: 10px; }
.p-empty p { font-size: 13px; max-width: 320px; }

.p-foot {
  padding: 10px 16px; border-top: 1px solid rgba(120,160,220,0.12);
  font-size: 11px; color: #5b6f94;
  background: rgba(16,29,57,0.5);
}
</style>
