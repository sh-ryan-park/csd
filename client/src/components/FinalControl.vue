<script setup lang="ts">
/**
 * 최종장 진행 (관리자, docs/100 N2 + D7). 게임 진행 카드 안에서 final 상태일 때 보인다.
 *   ① 최종 투표: 팀별 투표 현황(득표는 마감 전 비공개) → 마감(미투표 = 기권) → 동점이면 가위바위보 결과 입력
 *   ② 결과 발표: 상금 화폐 + 마지막 라운드 발행량 전체 공개
 *   ③ 정산: 보상 % 발표 (재화를 정정했으면 다시 계산)
 *   ④ 테러리스트 공개 (docs/100 N4): 이름·팀·보상 전체 공개 → 게임 끝내기
 * 다음 단계 요청에 보고 있던 단계를 함께 보내 중복 클릭·관리자 2명 동시 조작을 막는다 (서버 stale 거부).
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { GroupInfo } from '../../../shared/types'
import { FINAL_STEP_LABELS, ISSUE_TEAM_CODE, RESOURCE_LABELS, type AdminGameView, type Tiebreak } from '../../../shared/game'
import { api } from '../lib/api'
import { useGameStore } from '../stores/game'
import TeamMark from './TeamMark.vue'
import ModalDialog from './ModalDialog.vue'
import ResultsBoard from './ResultsBoard.vue'

const props = defineProps<{ groups: GroupInfo[] }>()
const router = useRouter()
const game = useGameStore()
const view = computed(() => game.admin!)
const f = computed(() => view.value.state.final!)
const busy = ref(false)
const status = ref('')
const team = (id: number) => props.groups.find((g) => g.id === id)
const issuer = (kind: 'gem' | 'gold') => props.groups.find((g) => g.code === ISSUE_TEAM_CODE[kind])?.name ?? kind
const notVoted = computed(() => Math.max(0, f.value.votes.eligible - f.value.votes.done))
const isTie = computed(() => !!f.value.tally && f.value.tally.gem === f.value.tally.gold)
const steps = ['vote', 'result', 'settle', 'spy'] as const

async function run(label: string, fn: () => Promise<AdminGameView>) {
  busy.value = true
  status.value = ''
  try {
    game.setAdmin(await fn())
    status.value = label
  } catch (e) {
    status.value = `실패: ${(e as Error).message}`
    void game.load()
  } finally {
    busy.value = false
    modal.value = null
  }
}

type ModalKind = 'close' | 'result' | 'settle' | 'spy' | 'end'
const modal = ref<ModalKind | null>(null)
const modalText = computed(() => {
  switch (modal.value) {
    case 'close':
      return {
        title: '최종 투표를 마감할까요?',
        message: `투표 ${f.value.votes.done} / ${f.value.votes.eligible}명.${notVoted.value ? ` 아직 투표하지 않은 ${notVoted.value}명은 기권 처리돼요.` : ''}\n마감하면 득표(보석 N표 · 골드 N표)가 전체에 공개되고, 더 이상 투표할 수 없어요.`,
      }
    case 'result':
      return {
        title: '결과를 발표할까요?',
        message: `상금 화폐 ${f.value.adopted ? RESOURCE_LABELS[f.value.adopted] : ''}와(과) 마지막 라운드 발행량(${issuer('gem')} 보석 · ${issuer('gold')} 골드)을 전체에 공개해요.`,
      }
    case 'settle':
      return { title: '정산을 발표할까요?', message: '지금 팀 재화로 보상 %를 계산해 전체에 공개해요. 발표 뒤 재화를 정정하면 "다시 계산" 을 누르세요.' }
    case 'spy': {
      const n = view.value.spy.spies.length
      return { title: '테러리스트를 공개할까요?', message: n ? `테러리스트 ${n}명의 이름·팀·보상을 전체에 공개해요.` : '테러리스트가 없었다고 전체에 알려요.' }
    }
    case 'end':
      return { title: '게임을 끝낼까요?', message: '결과는 그대로 남고, 더 이상 진행할 수 없어요.' }
    default:
      return { title: '', message: '' }
  }
})

function onConfirm() {
  switch (modal.value) {
    case 'close':
      return run('투표 마감', () => api.post('/api/admin/final/close'))
    case 'result':
      return run('결과 발표', () => api.post('/api/admin/final/next', { step: 'vote' }))
    case 'settle':
      return run('정산 발표', () => api.post('/api/admin/final/next', { step: 'result' }))
    case 'spy':
      return run('테러리스트 공개', () => api.post('/api/admin/final/next', { step: 'settle' }))
    case 'end':
      return run('게임 끝', () => api.post('/api/admin/final/next', { step: 'spy' }))
  }
}

function tiebreak(winner: Tiebreak) {
  return run('가위바위보 결과 입력', () => api.post('/api/admin/final/tiebreak', { winner }))
}
function recompute() {
  return run('정산 다시 계산', () => api.post('/api/admin/final/recompute'))
}
</script>

<template>
  <div class="final">
    <ol class="steps">
      <li v-for="st in steps" :key="st" :class="{ cur: f.step === st, past: steps.indexOf(f.step as never) > steps.indexOf(st) }">{{ FINAL_STEP_LABELS[st] }}</li>
    </ol>
    <p class="muted" style="min-height: 1.2em; margin: 6px 0 0">{{ status }}</p>

    <!-- ① 최종 투표 -->
    <template v-if="f.step === 'vote'">
      <h3>최종 투표 <span class="muted">{{ f.votes.done }} / {{ f.votes.eligible }}명</span>
        <span v-if="view.state.lifeVote" class="badge on">라이프 투표권 사용 가능</span>
        <span v-else class="badge">리더만 1표</span>
      </h3>
      <table class="tbl">
        <tbody>
          <tr v-for="v in view.finalVotes" :key="v.teamId">
            <td><TeamMark :color="team(v.teamId)?.color ?? ''" />{{ team(v.teamId)?.name }}</td>
            <td class="mono">{{ v.done }} / {{ v.eligible }}</td>
            <td><span v-if="v.eligible && v.done >= v.eligible" class="badge on">완료</span></td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px">
        <template v-if="!f.closed">
          <button class="danger" :disabled="busy" @click="modal = 'close'">투표 마감</button>
          <span class="muted">득표는 마감 전에는 관리자도 볼 수 없어요</span>
        </template>
        <template v-else>
          <strong class="mono">보석 {{ f.tally?.gem }}표 · 골드 {{ f.tally?.gold }}표</strong>
          <template v-if="isTie">
            <span class="badge warn">동점</span>
            <span>가위바위보:</span>
            <button :class="{ secondary: f.tiebreak !== 'white' }" :disabled="busy" @click="tiebreak('white')">{{ issuer('gem') }} 승 → 보석</button>
            <button :class="{ secondary: f.tiebreak !== 'yellow' }" :disabled="busy" @click="tiebreak('yellow')">{{ issuer('gold') }} 승 → 골드</button>
          </template>
        </template>
      </div>
      <div v-if="f.closed" class="row" style="margin-top: 10px">
        <button :disabled="busy || !f.adopted" @click="modal = 'result'">결과 발표 →</button>
        <span v-if="f.adopted" class="muted">채택 화폐: {{ RESOURCE_LABELS[f.adopted] }}</span>
        <span v-else class="blocker">동점이에요. 화이트·옐로우 리더 가위바위보 결과를 넣으세요</span>
      </div>
    </template>

    <!-- ② 결과 발표 · ③ 정산 -->
    <template v-else>
      <ResultsBoard :final="f" :results="view.state.results" />
      <div class="row" style="margin-top: 10px">
        <button v-if="f.step === 'result'" :disabled="busy" @click="modal = 'settle'">정산 발표 →</button>
        <template v-else-if="f.step === 'settle'">
          <button class="secondary" :disabled="busy" @click="recompute">다시 계산</button>
          <button :disabled="busy" @click="modal = 'spy'">테러리스트 공개 →</button>
        </template>
        <button v-else-if="f.step === 'spy'" class="danger" :disabled="busy" @click="modal = 'end'">게임 끝내기</button>
        <button v-if="view.state.results" class="secondary" @click="router.push('/prizes')">상금 계산</button>
      </div>
    </template>

    <ModalDialog
      :open="modal !== null"
      :title="modalText.title"
      :message="modalText.message"
      :confirm-label="modal === 'close' ? '마감' : modal === 'end' ? '끝내기' : modal === 'spy' ? '공개' : '발표'"
      cancel-label="닫기"
      :danger="modal === 'close' || modal === 'end'"
      :busy="busy"
      @confirm="onConfirm"
      @cancel="modal = null"
    />
  </div>
</template>

<style scoped>
h3 { font-size: 0.95rem; margin: 16px 0 6px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.steps { display: flex; gap: 4px; list-style: none; margin: 8px 0 0; padding: 0; flex-wrap: wrap; }
.steps li { font-size: 0.87rem; font-weight: 600; padding: 4px 10px 6px; border-bottom: 2px solid transparent; color: var(--muted); }
.steps li.past { color: #b0b8c1; }
.steps li.cur { color: var(--ink); border-bottom-color: var(--ink); }
.tbl { border-collapse: collapse; font-size: 0.92rem; }
.tbl td { text-align: left; padding: 5px 12px 5px 0; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
.blocker { color: var(--red); font-size: 0.88rem; }
.final :deep(.results) { margin: 10px 0 0; }
</style>
