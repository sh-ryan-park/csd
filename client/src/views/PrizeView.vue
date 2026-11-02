<script setup lang="ts">
/**
 * 상금 계산 (관리자). 발표된 정산으로 분배 방식별 등수별 팀 총합·인별 금액과 테러리스트 보상을 한 번에 보여 준다.
 * 금액과 규칙 문구는 서버(server/src/prize.ts)가 보내 주고 여기에는 두지 않는다.
 * 게임 상태가 바뀔 때마다(정산 발표·다시 계산·재화 정정·탈락·복귀) 다시 받는다.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { RESOURCE_LABELS, shareText, type PrizeSpy, type PrizeView } from '../../../shared/game'
import { api } from '../lib/api'
import { useGameStore } from '../stores/game'
import { useRealtimeStore } from '../stores/realtime'
import Icon from '../components/Icon.vue'
import TeamMark from '../components/TeamMark.vue'

const router = useRouter()
const game = useGameStore()
const rt = useRealtimeStore()
const view = ref<PrizeView | null>(null)
const error = ref('')

async function load() {
  try {
    view.value = await api.get<PrizeView>('/api/admin/prizes')
    error.value = ''
  } catch (e) {
    error.value = `불러오지 못했어요: ${(e as Error).message}`
  }
}
onMounted(() => {
  void load()
  if (!game.state) void game.load()
})
watch(() => [game.admin, rt.groupVersion], load)

const results = computed(() => view.value?.results ?? null)
const won = (n: number) => n.toLocaleString('ko-KR')
const publishedAt = computed(() => (results.value ? new Date(results.value.publishedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''))
const survivors = computed(() => results.value?.teams.reduce((sum, t) => sum + t.alive, 0) ?? 0)
/** 살아남은 사람이 없어 칸이 없는 팀도 게임 결과 표에는 남긴다 */
const noSurvivorTeams = computed(() => results.value?.teams.filter((t) => t.alive === 0) ?? [])
const shareOf = (teamId: number | null) => results.value?.teams.find((t) => t.teamId === teamId)

/** 테러리스트의 소속 칸 인별 금액 */
function spyBase(s: PrizeSpy, planIndex: number): number | null {
  if (s.column == null) return null
  return view.value?.plans[planIndex].cells?.[s.column].each ?? null
}
const teamName = (id: number | null) => shareOf(id)?.name ?? '-'
const teamColor = (id: number | null) => shareOf(id)?.color ?? ''
</script>

<template>
  <div class="page" style="max-width: 1100px">
    <div class="topbar">
      <div>
        <h1 style="margin: 0">상금 계산</h1>
        <span class="muted">관리자만 볼 수 있어요</span>
      </div>
      <div class="row">
        <button class="secondary" @click="router.push('/admin')">돌아가기</button>
      </div>
    </div>

    <div v-if="error" class="card"><p class="error" style="margin: 0">{{ error }}</p></div>
    <div v-else-if="!view" class="card"><p class="muted" style="margin: 0">불러오는 중…</p></div>
    <div v-else-if="!results" class="card">
      <h2>아직 계산할 결과가 없어요</h2>
      <p class="muted" style="margin: 0">최종장에서 정산을 발표하면 분배 방식별 상금과 테러리스트 보상이 여기에 나와요.</p>
    </div>

    <template v-else>
      <ul v-if="view.warnings.length" class="warnings">
        <li v-for="w in view.warnings" :key="w"><Icon name="warning" /> {{ w }}</li>
      </ul>

      <div class="card">
        <h2>게임 결과 <span class="muted">정산 발표 {{ publishedAt }}</span></h2>
        <p class="line">
          채택 화폐 <strong>{{ RESOURCE_LABELS[results.adopted] }}</strong>
          · 살아남은 사람 <strong class="mono">{{ survivors }}</strong>명
          · 탈락 <strong class="mono">{{ view.dead }}</strong>명
        </p>
        <div class="scroll">
          <table class="tbl">
            <thead>
              <tr><th>등수</th><th>팀</th><th class="num">인원</th><th class="num">{{ RESOURCE_LABELS[results.adopted] }} 보유량</th><th class="num">지분</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in view.columns" :key="c.teamId ?? 'dead'">
                <td><strong>{{ c.label }}</strong></td>
                <td><TeamMark v-if="c.color" :color="c.color" />{{ c.teamId == null ? '-' : c.name }}</td>
                <td class="num mono">{{ c.people }}명</td>
                <template v-if="c.teamId != null">
                  <td class="num mono">{{ shareOf(c.teamId)?.excluded ? '-' : won(shareOf(c.teamId)?.holding ?? 0) }}</td>
                  <td class="num mono">{{ shareOf(c.teamId)?.excluded ? '상대 발행팀' : shareText(shareOf(c.teamId)?.share ?? 0) }}</td>
                </template>
                <template v-else><td class="num">-</td><td class="num">-</td></template>
              </tr>
              <tr v-for="t in noSurvivorTeams" :key="t.teamId" class="dim">
                <td>-</td>
                <td><TeamMark :color="t.color" />{{ t.name }}</td>
                <td class="num mono">0명</td>
                <td class="num mono">{{ t.excluded ? '-' : won(t.holding) }}</td>
                <td class="num">상금 없음</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>분배 방식별 상금 <span class="muted">위 팀 총합 · 아래 인별 금액 · 단위 원</span></h2>
        <div class="scroll">
          <table class="tbl plans">
            <thead>
              <tr>
                <th class="sticky">분배 방식</th>
                <th v-for="c in view.columns" :key="c.teamId ?? 'dead'" class="num">
                  <span class="rank">{{ c.label }}</span>
                  <span class="who"><TeamMark v-if="c.color" :color="c.color" />{{ c.teamId == null ? '' : c.name }} {{ c.people }}명</span>
                </th>
                <th class="num">잔액</th>
                <th class="num">총 지출</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in view.plans" :key="p.name">
                <td class="sticky">
                  <strong>{{ p.name }}</strong>
                  <span v-if="p.note" class="note">{{ p.note }}</span>
                </td>
                <template v-if="p.cells">
                  <td v-for="(cell, i) in p.cells" :key="i" class="num mono">
                    <strong>{{ won(cell.total) }}<span v-if="cell.totalFlip" class="flip" title="위 등수보다 팀 총합이 많아요">▲</span></strong>
                    <span class="sub">{{ won(cell.each) }}<span v-if="cell.eachFlip" class="flip" title="위 등수보다 인별 금액이 많아요">▲</span></span>
                  </td>
                  <td class="num mono">{{ won(p.left ?? 0) }}</td>
                  <td class="num mono"><strong>{{ won(p.spend ?? 0) }}</strong></td>
                </template>
                <td v-else :colspan="view.columns.length + 2" class="muted">계산할 수 없어요</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted foot">
          인별 금액은 {{ won(view.unit) }}원 미만을 버려요. 팀 총합 = 인별 금액 × 인원, 잔액 = {{ won(view.total) }}원 − 팀 총합의 합, 총 지출 = 팀 총합의 합 + 테러리스트 보상이에요.
          <span class="flip">▲</span> 는 위 등수보다 금액이 많은 칸이에요.
        </p>
      </div>

      <div class="card">
        <h2><Icon name="spy" /> 테러리스트 보상 <span class="muted">시작 이후 탈락자 1명당 5천 원 (최대 5만 원) · 본인이 탈락하면 0원</span></h2>
        <p v-if="!view.spies.length" class="muted" style="margin: 0">테러리스트가 없었어요.</p>
        <template v-else>
          <div class="scroll">
            <table class="tbl plans">
              <thead>
                <tr>
                  <th rowspan="2" class="sticky">테러리스트</th>
                  <th rowspan="2" class="num">탈락자</th>
                  <th rowspan="2" class="num">보상</th>
                  <th :colspan="view.plans.length" class="group">분배 방식별 받는 금액</th>
                </tr>
                <tr>
                  <th v-for="p in view.plans" :key="p.name" class="num method">{{ p.name }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in view.spies" :key="s.userId">
                  <td class="sticky">
                    <strong>{{ s.name }}</strong>
                    <span class="sub"><TeamMark :color="teamColor(s.teamId)" />{{ teamName(s.teamId) }}{{ s.alive ? '' : ' · 탈락' }}</span>
                  </td>
                  <td class="num mono">{{ s.eliminated }}명</td>
                  <td class="num mono"><strong>{{ won(s.reward) }}</strong></td>
                  <td v-for="(p, i) in view.plans" :key="p.name" class="num mono">
                    <template v-if="spyBase(s, i) != null">
                      <strong>{{ won((spyBase(s, i) ?? 0) + s.reward) }}</strong>
                      <span class="sub">{{ won(spyBase(s, i) ?? 0) }} + {{ won(s.reward) }}</span>
                    </template>
                    <span v-else class="muted">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted foot">보상은 상금 {{ won(view.total) }}원과 따로 나가요. 받는 금액 = 소속 칸의 인별 금액 + 보상이에요.</p>
        </template>
      </div>

      <div class="card">
        <h2>분배 방식별 계산 규칙</h2>
        <dl class="rules">
          <template v-for="p in view.plans" :key="p.name">
            <dt>{{ p.name }}</dt>
            <dd>{{ p.rule }}</dd>
          </template>
        </dl>
      </div>
    </template>
  </div>
</template>

<style scoped>
.warnings { list-style: none; margin: 0 0 12px; padding: 12px 16px; border-radius: var(--radius-card); background: var(--amber-bg); color: var(--ink); }
.warnings li + li { margin-top: 4px; }
.line { margin: 0 0 12px; }
.scroll { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 0.93rem; }
.tbl th, .tbl td { text-align: left; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.tbl th { color: var(--muted); font-size: 0.87rem; font-weight: 600; white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl .num { text-align: right; white-space: nowrap; }
.tbl tr.dim td { color: var(--muted); }
.plans th.num:last-child, .plans td.num:last-child { padding-right: 0; }
.tbl th.group { text-align: center; }
.tbl th[rowspan], .tbl th.method { vertical-align: bottom; }
.tbl th.method { white-space: normal; min-width: 96px; }
.rank { display: block; color: var(--ink); font-size: 0.93rem; }
.who { display: block; font-weight: 500; }
.sub { display: block; color: var(--muted); font-size: 0.87rem; font-weight: 400; white-space: nowrap; }
.note { display: block; color: #b45f00; font-size: 0.87rem; font-weight: 600; white-space: nowrap; }
.flip { color: #d22030; margin-left: 2px; }
/* 좁은 화면에서 가로로 밀어도 어느 분배 방식인지 보이게 */
.sticky { position: sticky; left: 0; background: var(--surface); padding-right: 16px; }
.foot { margin: 12px 0 0; }
.rules { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0; }
.rules dt { font-weight: 700; }
.rules dd { margin: 0; color: var(--ink-2); }
/* 휴대폰: 분배 방식 칸을 좁혀 금액이 더 보이게, 규칙은 이름과 설명을 위아래로 */
@media (max-width: 480px) {
  .sticky { max-width: 96px; padding-right: 8px; }
  .sticky .sub, .sticky .note { white-space: normal; }
  .rules { grid-template-columns: 1fr; gap: 2px 0; }
  .rules dd { margin-bottom: 8px; }
}
</style>
