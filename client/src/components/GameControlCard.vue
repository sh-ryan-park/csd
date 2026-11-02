<script setup lang="ts">
import Icon from './Icon.vue'
/**
 * 게임 진행 (관리자): 준비 상태 점검·게임 시작 (리더는 1라운드 리더 선출부터) / 단계 넘기기 / 다음 날 / 게임 종료(= 최종장 시작) / 리셋, 그리고 현재 단계의 팀별 현황.
 * - 마지막 라운드 리더 협의: 필수 안건(라이프 투표권) 통과/부결 입력. 넣어야 라이프 제출로 넘어간다 (docs/100 N2)
 * - 이주 (docs/100 N3): 대기 신청 목록·강제 취소. 대기 신청이 있으면 리더 협의 → 라이프 제출로 넘어가지 못한다
 * - 테러리스트 (docs/100 N4): 준비 상태에 운명의 카드 현황(천사·악마·미선택)과 후보(악마) 목록 → 체크해서 지정. 후보가 있으면 1명 이상 지정해야 시작.
 *   진행 중에는 테러리스트와 현재 적립금 (관리자만)
 * - 최종장(final): FinalControl (투표 마감·가위바위보·결과·정산)
 * - 준비 상태: 팀별 입장 현황(A 3/5)과 리더. 리더가 없는 팀이 있으면 시작할 수 없다. 팀을 고르지 않은 참가자는 시작할 때 비활성.
 * - 리셋은 어느 상태에서나: 참가자·진행자 계정과 모든 기록·알림을 지우고 설정 단계로 (리셋한 사람이 진행자면 본인도 로그아웃).
 * - 다음 단계 요청에 보고 있던 일차·단계를 함께 보내 중복 클릭·관리자 2명 동시 조작을 막는다 (서버 stale 거부).
 * - 리더 선출 단계: 팀이 오프라인 협의 결과를 알려 오면 여기서 팀별로 리더를 지정한다 (docs/100 §7-6, 투표 없음). 팀원 1명은 자동.
 * - 거래 단계 (docs/103 §10): 오프라인 협의 내용을 여기서 입력해 "거래 진행" → 확인 팝업(예/아니오) 뒤 바로 체결 (2026-11-02 리더 수락 삭제).
 * - 전쟁 (docs/103 §4): 리더 선포 즉시 시작. 여기서는 결과만 지정하고, 승·패·무승부면 리더 협의로 자동 전환된다.
 * - 리더 협의 (docs/103 §11·§12): 원조는 팀 재화 카드에서, 다음 라운드 전쟁 허용/제재는 여기서 입력.
 */
import { computed, reactive, ref, watch } from 'vue'
import type { AdminUser, GroupInfo } from '../../../shared/types'
import {
  FINAL_STEP_LABELS, MIGRATION_CANCEL_LABELS, PHASE_LABELS, PHASES, RESOURCE_KINDS, RESOURCE_LABELS, DEFAULT_LAST_ISSUE_PHASES, WAR_COST_KINDS, WAR_STATUS_LABELS, emptyResources, isLifeExempt, josa, teamLetter,
  type AdminGameView, type Phase, type Resources, type TradeView, type WarCost, type WarResult,
} from '../../../shared/game'
import { useRouter } from 'vue-router'
import { api } from '../lib/api'
import { useGameStore } from '../stores/game'
import { useAuthStore } from '../stores/auth'
import { teamInk } from '../lib/teamColor'
import TeamMark from './TeamMark.vue'
import ModalDialog from './ModalDialog.vue'
import ResourceRow from './ResourceRow.vue'
import PhaseChecks from './PhaseChecks.vue'
import TabLoginToggle from './TabLoginToggle.vue'
import FinalControl from './FinalControl.vue'
import ResultsBoard from './ResultsBoard.vue'

const props = defineProps<{ users: AdminUser[]; groups: GroupInfo[] }>()
defineEmits<{ updated: [users: AdminUser[]] }>()
const game = useGameStore()
const auth = useAuthStore()
const router = useRouter()
const view = computed(() => game.admin)
const s = computed(() => view.value?.state)
const busy = ref(false)
const status = ref('')

const nameOf = (id: number | null | undefined) => props.users.find((u) => u.id === id)?.name ?? (id == null ? '-' : `#${id}`)
const team = (id: number) => props.groups.find((g) => g.id === id)

const isLastDay = computed(() => !!s.value && s.value.day >= (s.value.totalDays ?? 0))
/**
 * 게임 종료: 마지막 날에는 버튼을 계속 보여 주되, 그날 턴이 모두 끝나야(라이프 제출 단계 + 모든 팀 제출) 활성.
 * 서버도 같은 조건으로 막는다 (409 not_finished). 0·1명 팀은 제출 불필요라 완료로 본다
 */
const canEnd = computed(() => isLastDay.value && s.value?.phase === 'life' && !!s.value.livesDone && !warBlocker.value)
/** 아직 라이프를 제출하지 않은(제출 대상인) 팀 이름 */
const lifePending = computed(() =>
  (view.value?.teams ?? []).filter((t) => !t.lifeSubmission && t.activeMembers > 0 && !isLifeExempt(t.activeMembers, t.resources.life)).map((t) => team(t.teamId)?.name ?? `#${t.teamId}`),
)
const endBlocker = computed(() => {
  if (!isLastDay.value || canEnd.value) return ''
  if (warBlocker.value) return warBlocker.value
  if (s.value?.phase !== 'life') return '마지막 라운드 라이프 제출 단계에서 모든 팀이 제출하면 종료할 수 있어요'
  return `라이프 미제출: ${lifePending.value.join(', ')} — 모든 팀이 제출하면 종료할 수 있어요`
})
// ---- 전쟁 (docs/99) ----
const warToday = computed(() => view.value?.war.today ?? null)
/** 진행 중 전쟁이 있으면 단계 넘기기·게임 종료 불가 (서버도 409 war_active) */
const warActive = computed(() => warToday.value?.status === 'declared')
const warBlocker = computed(() => (warActive.value ? '전쟁 결과를 먼저 정하세요' : ''))
/** 다음 라운드 전쟁 허용/제재 (리더 협의 단계, docs/103 §12) */
function setWarAllowed(allowed: boolean) {
  return run(`${(s.value?.day ?? 0) + 1}라운드 전쟁 ${allowed ? '허용' : '제재'}`, () => api.post('/api/admin/war/allow', { allowed }))
}
const costText = (c: WarCost | null | undefined) =>
  !c ? '미정' : WAR_COST_KINDS.filter((k) => c[k] > 0).map((k) => `${RESOURCE_LABELS[k]} ${c[k]}`).join(', ') || '없음 (무료)'
/** 다음 날 선포 비용 입력 (저장해야 "다음 날로" 가 눌린다) */
const nextCost = reactive<WarCost>({ gem: 0, gold: 0, credit: 0 })
watch(() => view.value?.war.nextCost, (c) => Object.assign(nextCost, c ?? { gem: 0, gold: 0, credit: 0 }), { immediate: true })
// ---- 마지막 라운드 발행 단계 (docs/100 D4): 마지막 라운드 전날까지 변경, 시작되면 고정 ----
const lastPhases = ref<Phase[]>([...DEFAULT_LAST_ISSUE_PHASES])
watch(() => view.value?.settings.lastIssuePhases, (p) => (lastPhases.value = [...(p ?? DEFAULT_LAST_ISSUE_PHASES)]), { immediate: true })
const lastPhasesText = (p: readonly Phase[] | undefined) => (p ?? []).map((x) => PHASE_LABELS[x]).join(', ')
const lastPhasesDirty = computed(() => lastPhases.value.join() !== (view.value?.settings.lastIssuePhases ?? []).join())
function saveLastPhases() {
  return run('마지막 라운드 발행 단계 저장', () => api.put('/api/admin/game/last-issue', { phases: lastPhases.value }))
}

function saveNextCost() {
  const day = (s.value?.day ?? 0) + 1
  const body = Object.fromEntries(WAR_COST_KINDS.map((k) => [k, Math.max(0, Math.floor(nextCost[k] || 0))]))
  return run(`${day}라운드 전쟁 선포 비용 저장`, () => api.post('/api/admin/war/cost', body))
}
const warResult = ref<WarResult | null>(null)
function askWar(result: WarResult) {
  warResult.value = result
  modal.value = 'war'
}
// ---- 테러리스트 (docs/100 N4) ----
const spyPick = ref<number[]>([])
watch(() => view.value?.spy.selected, (ids) => (spyPick.value = [...(ids ?? [])]), { immediate: true })
const spyDirty = computed(() => [...spyPick.value].sort().join() !== [...(view.value?.spy.selected ?? [])].sort().join())
const spyBlocker = computed(() => {
  const sp = view.value?.spy
  if (!sp || !sp.candidates.length) return ''
  if (!sp.selected.length) return '악마를 고른 후보 중 테러리스트를 1명 이상 지정해 저장해야 시작할 수 있어요'
  return ''
})
function saveSpies() {
  return run('테러리스트 지정 저장', () => api.put('/api/admin/spies', { userIds: spyPick.value }))
}
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

// ---- 이주 (docs/100 N3) ----
const migrationOpenFrom = computed(() => view.value?.settings.migrationStartDay ?? 4)
const MIGRATION_STATUS: Record<string, string> = { accepted: '이주 완료', rejected: '거절' }
function cancelMigration(id: number) {
  return run('이주 신청 취소', () => api.post(`/api/admin/migration/${id}/cancel`))
}

// ---- 마지막 라운드 필수 안건: 남은 라이프를 최종 투표권으로 (docs/100 N2) ----
const lifeVoteOpen = computed(() => s.value?.status === 'running' && isLastDay.value && s.value.phase === 'council')
function setLifeVote(passed: boolean) {
  return run(`라이프 투표권 안건 ${passed ? '통과' : '부결'}`, () => api.post('/api/admin/game/life-vote', { passed }))
}

/** 다음 단계/다음 날 버튼을 막는 이유 */
const advanceBlocker = computed(() => {
  if (warBlocker.value) return warBlocker.value
  if (s.value?.phase === 'council' && view.value?.migrations.pending.length) return '처리하지 않은 이주 신청이 있어요. 받는 팀 리더가 처리하거나 아래 "이주" 에서 취소해야 라이프 제출로 넘어갈 수 있어요'
  if (lifeVoteOpen.value && s.value?.lifeVote == null) return '라이프 투표권 안건의 통과/부결을 아래에서 입력해야 라이프 제출로 넘어갈 수 있어요'
  if (!nextPhase.value && !isLastDay.value && !view.value?.war.nextCost) return `${(s.value?.day ?? 0) + 1}라운드 전쟁 선포 비용을 아래 "전쟁" 에서 정해야 다음 라운드로 넘어갈 수 있어요`
  return ''
})

const nextPhase = computed(() => {
  const p = s.value?.phase
  if (!p) return null
  const i = PHASES.indexOf(p)
  return i < PHASES.length - 1 ? PHASES[i + 1]! : null
})

interface ResetSummary { members: number; staff: number; events: number; clearedSettings: boolean }

async function run(label: string, fn: () => Promise<AdminGameView & { removedSelf?: boolean; reset?: ResetSummary }>) {
  busy.value = true
  status.value = ''
  resetDone.value = null
  try {
    const res = await fn()
    if (res.reset) resetDone.value = res.reset
    // 진행자가 리셋하면 본인 계정도 지워진다
    if (res.removedSelf) {
      auth.clear()
      void router.push('/login')
      return
    }
    game.setAdmin(res)
    status.value = label
  } catch (e) {
    status.value = `실패: ${(e as Error).message}`
    void game.load()
  } finally {
    busy.value = false
    modal.value = null
  }
}

// ---- 리셋: 설정값도 비울지 확인 팝업에서 고른다. 끝나면 지운 것/남은 것을 눈에 띄게 보여준다 ----
const clearSettings = ref(false)
const resetDone = ref<ResetSummary | null>(null)

// ---- 확인 팝업 ----
type ModalKind = 'next' | 'end' | 'reset' | 'cancelTrade' | 'start' | 'revert' | 'war' | 'trade'
const modal = ref<ModalKind | null>(null)
const modalText = computed(() => {
  const st = s.value
  if (!st) return { title: '', message: '' }
  switch (modal.value) {
    case 'next': {
      if (nextPhase.value) {
        const warn = st.phase === 'leader' && !st.leadersDone
          ? '\n아직 리더를 지정하지 않은 팀은 현재 리더를 유지해요.'
          : st.phase === 'trade' && view.value?.trade ? '\n진행 중인 거래는 취소돼요.' : ''
        return { title: `${PHASE_LABELS[nextPhase.value]} 단계로 넘길까요?`, message: `${st.day}라운드 · ${PHASE_LABELS[st.phase!]} → ${PHASE_LABELS[nextPhase.value]}${warn}` }
      }
      const warn = st.livesDone ? '' : '\n아직 라이프를 제출하지 않은 팀이 있어요. 미제출 팀은 라이프 소모·탈락 없이 넘어가요.'
      // 마지막 라운드로 넘어갈 때: 발행 허용 단계를 한 번 더 보여 준다 (넘어가면 바꿀 수 없다)
      const last = st.day + 1 >= (st.totalDays ?? 0)
        ? `\n\n${st.day + 1}라운드는 마지막 라운드예요. 발행 허용 단계: ${lastPhasesText(view.value?.settings.lastIssuePhases)}` +
          '\n마지막 라운드가 시작되면 바꿀 수 없어요. 바꾸려면 취소하고 아래 "마지막 라운드 발행 단계"에서 저장하세요.'
        : ''
      return { title: last ? `마지막 라운드(${st.day + 1}라운드)로 넘길까요?` : `${st.day + 1}라운드로 넘길까요?`, message: `이번 라운드가 끝나고 ${st.day + 1}라운드 리더 선출이 시작돼요.${warn}${last}` }
    }
    case 'end': {
      const lv = st.lifeVote ? '리더 1표 + 라이프 투표권 (팀 라이프 1개로 1표, 1인 1장. 팀원은 라이프 투표권으로만)' : '리더만 1표 (라이프 투표권 안건 부결)'
      return {
        title: '게임을 종료하고 최종장을 시작할까요?',
        message: `${st.day}라운드 모든 팀의 라이프 제출이 끝났어요. 거래·발행·원조는 더 이상 할 수 없어요.\n최종 투표(보석 vs 골드)가 열려요 · ${lv}.`,
      }
    }
    case 'reset': {
      const self = !props.users.find((u) => u.id === auth.user?.id)?.isFixed
      return {
        title: '게임을 리셋할까요?',
        message: '참가자·진행자 계정을 모두 삭제하고(관리자·프레젠테이션 계정만 남음), 재화 이력·투표·거래·라이프 기록과 공지를 포함한 모든 알림을 지운 뒤 설정 단계로 돌아가요.\n'
          + '팀 구성·룰 문서는 남고 총 라운드 수는 비웁니다. 테스트 계정은 같은 PIN 으로 다시 만들어져요.'
          + (self ? '\n지금 로그인한 진행자 계정도 삭제되어 로그아웃돼요.' : ''),
      }
    }
    case 'start': {
      const p = view.value?.prep
      const warn = p?.unassigned ? `\n팀을 고르지 않은 참가자 ${p.unassigned}명은 비활성(로그인 차단) 처리돼요. 나중에 계정 관리에서 팀에 넣고 복귀시킬 수 있어요.` : ''
      // 테스트 모드(탭 로그인)를 끄는 걸 잊지 않게 (docs/101)
      const sp = view.value?.spy
      const spyWarn = !sp ? '' : sp.selected.length
        ? `\n테러리스트 ${sp.selected.length}명: ${sp.selected.map(nameOf).join(', ')} (시작하면 본인에게만 무음으로 알려요)`
        : '\n\n악마를 고른 후보가 없어 테러리스트 없이 시작해요.'
      const fateWarn = sp?.counts.none ? `\n운명의 카드를 고르지 않은 ${sp.counts.none}명은 천사로 처리돼요.` : ''
      const tab = view.value?.settings.tabLogin ? '\n\n테스트 모드(탭 로그인)가 켜져 있어요. 참가자가 새 탭을 열 때마다 다시 로그인해야 해요. 실제 진행이면 "게임 설정"에서 끄세요.' : ''
      return { title: '게임을 시작할까요?', message: `총 ${st.totalDays}라운드. 시작하면 참가자 화면이 게임 화면으로 바뀌고 1라운드 리더 선출이 열려요.${warn}${fateWarn}${spyWarn}${tab}` }
    }
    case 'revert':
      return { title: '설정 단계로 되돌릴까요?', message: '참가자는 팀을 고를 수 없게 돼요. 이미 팀을 고른 참가자와 PIN 은 그대로 남아요.' }
    case 'cancelTrade':
      return { title: '대기 중인 거래를 취소할까요?', message: '아직 체결되지 않은 거래라 재화는 그대로예요. 취소한 뒤 아래에서 다시 진행하세요.' }
    case 'trade':
      return {
        title: '거래를 진행할까요?',
        message: `${tradeSummaryText.value}\n확인하면 바로 크레딧 1개(${team(tradeForm.creditPayer ?? 0)?.name ?? ''})가 빠지고 재화가 교환돼요. 되돌릴 수 없어요.`,
      }
    case 'war': {
      const w = warToday.value
      if (!w) return { title: '', message: '' }
      const a = team(w.attacker)?.name ?? '공격팀'
      const d = team(w.defender)?.name ?? '방어팀'
      const r = warResult.value
      if (r === 'attacker' || r === 'defender') {
        const win = r === 'attacker' ? a : d
        const lose = r === 'attacker' ? d : a
        return {
          title: `${win} 승리로 정할까요?`,
          message: `${a} → ${d}\n${lose}의 모든 재화(보석·골드·라이프·크레딧) 절반(내림)을 ${josa(win, '이/가')} 가져가요.\n결과는 전체에 알리고, 가져간 수량은 ${win}에게만 보여요. 되돌릴 수 없어요.`,
        }
      }
      if (r === 'draw') return { title: '무승부로 정할까요?', message: `${a} → ${d}\n재화 이동은 없고, 낸 선포 비용은 돌려주지 않아요. 되돌릴 수 없어요.` }
      return { title: '전쟁을 취소할까요?', message: `${a} → ${d}\n재화 이동은 없고, 낸 선포 비용은 돌려주지 않아요. 이번 라운드에는 다시 선포할 수 없어요.` }
    }
    default:
      return { title: '', message: '' }
  }
})

function onConfirm() {
  const st = s.value!
  switch (modal.value) {
    case 'next':
      return run('넘김', () => api.post('/api/admin/game/next', { day: st.day, phase: st.phase }))
    case 'end':
      return run('게임 종료', () => api.post('/api/admin/game/end'))
    case 'reset':
      return run('', () => api.post('/api/admin/game/reset', { clearSettings: clearSettings.value }))
    case 'cancelTrade':
      return run('거래 취소됨', () => api.post('/api/admin/game/trade/cancel'))
    case 'start':
      return run('게임 시작', () => api.post('/api/admin/game/start'))
    case 'revert':
      return run('설정 단계로 되돌림', () => api.post('/api/admin/game/revert'))
    case 'war':
      return run('전쟁 결과 지정', () => api.post(`/api/admin/war/${warToday.value!.id}/resolve`, { result: warResult.value }))
    case 'trade':
      return submitTrade()
  }
}

// ---- 준비: 팀별 입장 현황 ----
const letterOfTeam = (teamId: number) => teamLetter(props.groups.findIndex((g) => g.id === teamId))
const lobbyOf = (teamId: number) => s.value?.lobby?.find((l) => l.teamId === teamId)
const membersOf = (teamId: number) => props.users.filter((u) => u.role === 'member' && u.active && u.groupId === teamId)
const leaderOf = (teamId: number) => membersOf(teamId).find((u) => u.isLeader)

// ---- 리더 선출 단계: 팀별 수동 지정 ----
const leaderPick = ref<Record<number, number>>({})
function designate(teamId: number) {
  const userId = leaderPick.value[teamId] ?? leaderOf(teamId)?.id
  if (!userId) return
  return run(`${team(teamId)?.name} 리더 지정: ${nameOf(userId)}`, () => api.post('/api/admin/game/leader', { teamId, userId }))
}

// ---- 거래 (docs/103 §10): 진행자가 내용을 입력해 올린다 ----
const offerText = (o: Resources | null) =>
  o ? (Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${RESOURCE_LABELS[k as keyof Resources]} ${n}`).join(', ') || '없음') : '-'
const tradeLine = (t: TradeView) => `${team(t.from.teamId)?.name} ↔ ${team(t.to.teamId)?.name}`
const tradeForm = reactive<{ from: number | null; to: number | null; creditPayer: number | null; fromOffer: Resources; toOffer: Resources }>({
  from: null, to: null, creditPayer: null, fromOffer: emptyResources(), toOffer: emptyResources(),
})
// 팀을 바꾸면 크레딧 부담 팀이 거래 팀 밖이 되지 않게
watch(() => [tradeForm.from, tradeForm.to], ([f, t]) => {
  if (tradeForm.creditPayer !== f && tradeForm.creditPayer !== t) tradeForm.creditPayer = f ?? null
})
const teamRes = (id: number | null) => view.value?.teams.find((t) => t.teamId === id)?.resources ?? emptyResources()
/** 보유량 초과·크레딧 부족 등 제출 전 점검 */
const tradeProblem = computed(() => {
  const f = tradeForm.from, t = tradeForm.to
  if (!f || !t) return '두 팀을 고르세요'
  if (f === t) return '같은 팀끼리는 거래할 수 없어요'
  if (!tradeForm.creditPayer) return '크레딧을 낼 팀을 고르세요'
  if (RESOURCE_KINDS.every((k) => !tradeForm.fromOffer[k] && !tradeForm.toOffer[k])) return '교환할 재화를 입력하세요'
  for (const [id, offer] of [[f, tradeForm.fromOffer], [t, tradeForm.toOffer]] as const) {
    const own = teamRes(id)
    const need = { ...offer, credit: (offer.credit || 0) + (tradeForm.creditPayer === id ? 1 : 0) }
    const short = RESOURCE_KINDS.find((k) => (need[k] || 0) > own[k])
    if (short) return `${team(id)?.name}의 ${RESOURCE_LABELS[short]}이(가) 부족해요 (필요 ${need[short]}, 보유 ${own[short]})`
  }
  return ''
})
const tradeSummaryText = computed(() =>
  `${team(tradeForm.from ?? 0)?.name} (${offerText(tradeForm.fromOffer)}) ↔ ${team(tradeForm.to ?? 0)?.name} (${offerText(tradeForm.toOffer)}) · 크레딧 ${team(tradeForm.creditPayer ?? 0)?.name} 부담`)
async function submitTrade() {
  const body = {
    fromTeamId: tradeForm.from, toTeamId: tradeForm.to, creditPayer: tradeForm.creditPayer,
    fromOffer: Object.fromEntries(RESOURCE_KINDS.map((k) => [k, Math.max(0, Math.floor(tradeForm.fromOffer[k] || 0))])),
    toOffer: Object.fromEntries(RESOURCE_KINDS.map((k) => [k, Math.max(0, Math.floor(tradeForm.toOffer[k] || 0))])),
  }
  await run(`거래 완료: ${tradeSummaryText.value}`, () => api.post('/api/admin/game/trade', body))
  Object.assign(tradeForm.fromOffer, emptyResources())
  Object.assign(tradeForm.toOffer, emptyResources())
}
const teamStyle = (id: number | null) => (id && team(id) ? { '--team': teamInk(team(id)!.color) ?? '' } : {})

</script>

<template>
  <div v-if="view && s" class="card">
    <h2>게임 진행</h2>

    <div class="row controls">
      <span v-if="s.status === 'setup'" class="mono"><strong>게임 설정 중</strong> · 아래 "게임 설정" 카드에서 초기셋팅완료</span>
      <template v-else-if="s.status === 'ready'">
        <span class="mono"><strong>게임 준비 중</strong> · 참가자 입장·팀 선택</span>
        <button class="secondary" :disabled="busy" @click="modal = 'revert'">설정으로 되돌리기</button>
        <button :disabled="busy || !view.settings.warCost || !!spyBlocker" @click="modal = 'start'">게임 시작</button>
        <span v-if="spyBlocker" class="blocker">{{ spyBlocker }}</span>
        <span v-if="!view.settings.warCost" class="blocker">아래 "게임 설정" 에서 1라운드 전쟁 선포 비용을 저장하세요</span>
      </template>
      <template v-else-if="s.status === 'running'">
        <span class="mono">{{ s.day }}라운드 / 총 {{ s.totalDays }}라운드 · <strong>{{ PHASE_LABELS[s.phase!] }}</strong></span>
        <button v-if="nextPhase" :disabled="busy || !!advanceBlocker" @click="modal = 'next'">다음 단계: {{ PHASE_LABELS[nextPhase] }} →</button>
        <button v-else-if="!isLastDay" :disabled="busy || !!advanceBlocker" @click="modal = 'next'">다음 라운드로 ({{ s.day + 1 }}라운드) →</button>
        <span v-if="advanceBlocker && (nextPhase || !isLastDay)" class="blocker">{{ advanceBlocker }}</span>
        <button v-if="isLastDay" :disabled="busy || !canEnd" class="danger" @click="modal = 'end'">게임 종료 (최종장 시작)</button>
        <span v-if="endBlocker" class="blocker">{{ endBlocker }}</span>
      </template>
      <span v-else-if="s.status === 'final'" class="mono"><strong>최종장</strong> · {{ s.final ? FINAL_STEP_LABELS[s.final.step] : '' }}</span>
      <span v-else class="mono"><strong>게임 끝</strong></span>
      <span class="spacer" />
      <button class="secondary" :disabled="busy" @click="clearSettings = false; modal = 'reset'">게임 리셋</button>
    </div>
    <p class="muted" style="min-height: 1.2em; margin: 6px 0 0">{{ status }}</p>
    <!-- 시작 후에는 게임 설정 카드가 숨으므로 여기서 테스트 모드를 끌 수 있게 (docs/101) -->
    <div v-if="s.status === 'running' || s.status === 'final' || s.status === 'ended'" class="row" style="margin: 4px 0 8px">
      <TabLoginToggle />
    </div>
    <div v-if="resetDone" class="reset-done">
      <strong>리셋 완료</strong> · 참가자 {{ resetDone.members }}명 · 진행자 {{ resetDone.staff }}명 · 알림 {{ resetDone.events }}건 삭제, 테스트 계정은 같은 PIN 으로 다시 생성.
      <br />
      <template v-if="resetDone.clearedSettings">게임 설정값(최대 인원·초기 재화)도 0 으로 비웠어요 (발행 한도는 기본값 250·200).</template>
      <template v-else>게임 설정값(최대 인원·초기 재화)은 이전 값을 남겼어요. 아래 "게임 설정" 카드에서 수정하세요.</template>
      <button class="secondary small" type="button" @click="resetDone = null">닫기</button>
    </div>

    <!-- 준비: 팀별 입장 현황 -->
    <template v-if="s.status === 'ready'">
      <h3>팀 입장 현황</h3>
      <table class="tbl">
        <thead><tr><th>팀</th><th>입장 / 최대</th></tr></thead>
        <tbody>
          <tr v-for="(g, i) in groups" :key="g.id">
            <td><span class="mono letter">{{ teamLetter(i) }}</span> <TeamMark :color="g.color" />{{ g.name }}</td>
            <td class="mono">{{ lobbyOf(g.id)?.count ?? 0 }} / {{ lobbyOf(g.id)?.capacity ?? 0 }}<span v-if="membersOf(g.id).some((u) => u.isTest)" class="muted"> + 테스트 {{ membersOf(g.id).filter((u) => u.isTest).length }}</span></td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="margin: 8px 0 0">
        팀을 고르지 않은 참가자 {{ view.prep.unassigned }}명<template v-if="view.prep.unassigned"> · 시작하면 비활성 처리돼요</template>.
        리더는 시작 후 1라운드 리더 선출 단계에서 지정해요.
        팀 이동은 아래 "계정 관리"에서 할 수 있어요.
      </p>

      <!-- 운명의 카드 · 테러리스트 지정 (docs/100 N4) -->
      <h3><Icon name="devil" /> 운명의 카드 · 테러리스트 지정</h3>
      <p class="muted" style="margin: 0 0 6px">
        팀을 고른 참가자는 천사/악마 중 하나를 골라요 (악마 = 테러리스트 후보).
        <Icon name="angel" /> 천사 <strong>{{ view.spy.counts.sun }}</strong> · <Icon name="devil" /> 악마 <strong>{{ view.spy.counts.moon }}</strong> · 미선택 <strong>{{ view.spy.counts.none }}</strong>
      </p>
      <p v-if="!view.spy.candidates.length" class="muted" style="margin: 0">아직 악마를 고른 후보가 없어요. 후보가 없으면 테러리스트 없이 시작해요.</p>
      <template v-else>
        <table class="tbl">
          <thead><tr><th>지정</th><th>팀</th><th>후보</th></tr></thead>
          <tbody>
            <tr v-for="c in view.spy.candidates" :key="c.userId">
              <td><input v-model="spyPick" type="checkbox" :value="c.userId" :disabled="busy" /></td>
              <td><span class="mono letter">{{ letterOfTeam(c.teamId) }}</span> <TeamMark :color="team(c.teamId)?.color ?? ''" />{{ team(c.teamId)?.name }}</td>
              <td>{{ c.name }}<span v-if="c.isTest" class="muted"> (테스트)</span></td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="margin-top: 8px">
          <button class="small" :disabled="busy || !spyDirty" @click="saveSpies">테러리스트 지정 저장 ({{ spyPick.length }}명)</button>
          <span v-if="view.spy.selected.length" class="muted">저장됨: {{ view.spy.selected.map(nameOf).join(', ') }}</span>
          <span v-else class="blocker">아직 지정하지 않음</span>
        </div>
      </template>
    </template>

    <!-- 테러리스트 현황 (관리자만) -->
    <template v-if="(s.status === 'running' || s.status === 'final') && view.spy.spies.length">
      <h3><Icon name="spy" /> 테러리스트 <span class="muted">관리자만 보여요 · 시작 이후 탈락자 1명당 5천 원 (최대 5만 원)</span></h3>
      <table class="tbl">
        <tbody>
          <tr v-for="x in view.spy.spies" :key="x.userId">
            <td><strong>{{ x.name }}</strong></td>
            <td><TeamMark :color="team(x.teamId ?? 0)?.color ?? ''" />{{ x.teamId != null ? team(x.teamId)?.name : '-' }}</td>
            <td class="mono">탈락자 {{ x.eliminated }}명</td>
            <td class="mono"><strong>{{ x.alive ? won(x.reward) : '탈락 · 0원' }}</strong></td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 리더 선출 -->
    <template v-if="s.status === 'running' && s.phase === 'leader'">
      <h3>리더 선정 <span v-if="s.leadersDone" class="badge on">모든 팀 완료</span></h3>
      <div class="muted">팀이 협의한 리더를 알려 오면 팀별로 지정하세요. 팀원 1명은 자동. 지정 없이 넘기면 현재 리더가 유지돼요.</div>
      <table class="tbl">
        <tbody>
          <tr v-for="t in view.teams" :key="t.teamId">
            <td><TeamMark :color="team(t.teamId)?.color ?? ''" />{{ team(t.teamId)?.name }}</td>
            <td>
              <template v-if="!t.election || membersOf(t.teamId).length === 0">-</template>
              <span v-else class="row">
                <span v-if="t.election.status === 'done'" class="badge on">지정 완료</span>
                <span v-else class="badge warn">대기</span>
                <select v-model="leaderPick[t.teamId]">
                  <option :value="undefined" disabled>{{ leaderOf(t.teamId) ? `현재: ${leaderOf(t.teamId)?.name}` : '리더 선택' }}</option>
                  <option v-for="u in membersOf(t.teamId)" :key="u.id" :value="u.id">{{ u.name }}{{ u.isLeader ? ' (현재 리더)' : '' }}</option>
                </select>
                <button class="small" :disabled="busy || (!leaderPick[t.teamId] && !leaderOf(t.teamId)) || membersOf(t.teamId).length === 1" :title="leaderPick[t.teamId] ? '' : '고르지 않으면 현재 리더를 그대로 확정해요'" @click="designate(t.teamId)">리더 지정</button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 생산 -->
    <p v-if="s.status === 'running' && s.phase === 'production'" class="muted">
      오프라인 미니게임 결과를 아래 "팀 재화" 카드에서 "생산" 으로 입력하세요. 팀 선택 칸이 고른 팀의 색으로 바뀌니 팀을 확인하고 적용하세요.
    </p>

    <!-- 거래 -->
    <template v-if="s.status === 'running' && s.phase === 'trade'">
      <h3><Icon name="aid" /> 거래 <span class="muted">오프라인 협의 → 여기서 입력 → 확인하면 바로 체결</span></h3>
      <!-- 리더 수락 방식(2026-11-02 이전)으로 올려 둔 대기 거래가 남아 있으면 취소해야 새로 진행할 수 있다 -->
      <div v-if="view.trade" class="trade">
        <div><strong>{{ tradeLine(view.trade) }}</strong> <span class="badge warn">이전 방식 대기 거래</span></div>
        <div class="muted">
          {{ team(view.trade.from.teamId)?.name }} 줌: {{ offerText(view.trade.from.offer) }}
          · {{ team(view.trade.to.teamId)?.name }} 줌: {{ offerText(view.trade.to.offer) }}
          · 크레딧 {{ team(view.trade.creditPayer)?.name }} 부담
        </div>
        <button class="secondary small" :disabled="busy" @click="modal = 'cancelTrade'">취소하고 다시 진행</button>
      </div>
      <div v-else-if="warActive" class="muted"><Icon name="war" /> 전쟁 중에는 거래할 수 없어요.</div>
      <form v-else class="trade-form" @submit.prevent="!tradeProblem && (modal = 'trade')">
        <div class="row">
          <select v-model="tradeForm.from" class="team-select" :class="{ picked: !!tradeForm.from }" :style="teamStyle(tradeForm.from)">
            <option :value="null" disabled>팀 A</option>
            <option v-for="g in groups" :key="g.id" :value="g.id" :disabled="g.id === tradeForm.to">{{ g.name }}</option>
          </select>
          ↔
          <select v-model="tradeForm.to" class="team-select" :class="{ picked: !!tradeForm.to }" :style="teamStyle(tradeForm.to)">
            <option :value="null" disabled>팀 B</option>
            <option v-for="g in groups" :key="g.id" :value="g.id" :disabled="g.id === tradeForm.from">{{ g.name }}</option>
          </select>
          <span class="muted"><Icon name="credit" /> 크레딧 1개 부담:</span>
          <label v-for="id in [tradeForm.from, tradeForm.to]" :key="id ?? 0" class="row" style="gap: 4px">
            <input v-model="tradeForm.creditPayer" type="radio" :value="id" :disabled="!id" /> {{ id ? team(id)?.name : '-' }}
          </label>
        </div>
        <div v-for="side in (['from', 'to'] as const)" :key="side" class="row offer-row" :style="teamStyle(tradeForm[side])">
          <span class="who"><TeamMark :color="team(tradeForm[side] ?? 0)?.color ?? ''" />{{ tradeForm[side] ? josa(team(tradeForm[side]!)?.name ?? '', '이/가') : (side === 'from' ? '팀 A가' : '팀 B가') }} 줌</span>
          <label v-for="k in RESOURCE_KINDS" :key="k" class="row" style="gap: 4px">
            {{ RESOURCE_LABELS[k] }} <input v-model.number="tradeForm[side === 'from' ? 'fromOffer' : 'toOffer'][k]" type="number" min="0" style="width: 4.5em" :title="`보유 ${teamRes(tradeForm[side])[k]}`" />
          </label>
          <span class="muted">보유: {{ offerText(teamRes(tradeForm[side])) }}</span>
        </div>
        <div class="row">
          <button type="submit" :disabled="busy || !!tradeProblem">거래 진행 →</button>
          <span v-if="tradeProblem" class="muted">{{ tradeProblem }}</span>
          <span v-else class="muted">두 팀 리더 화면에 요약이 뜨고, 둘 다 "예" 를 누르면 체결돼요</span>
        </div>
      </form>
    </template>

    <!-- 전쟁: 오늘 비용·진행 중 전쟁 결과 지정·다음 날 비용 -->
    <template v-if="s.status === 'running'">
      <h3><Icon name="war" /> 전쟁</h3>
      <p class="muted" style="margin-top: 0">
        이번 라운드({{ s.day }}라운드)
        <template v-if="!view.war.todayAllowed"><strong class="error">전쟁 금지</strong> (리더 협의 결과 · 선포 불가)</template>
        <template v-else>선포 비용: <strong>{{ costText(view.war.todayCost) }}</strong> · 거래 단계에서 리더가 선포하면 즉시 시작 (라운드당 1회, 먼저 선포한 팀만). 낸 비용은 소멸해요.</template>
      </p>
      <div v-if="warToday && warActive" class="war-active">
        <div><strong><Icon name="war" /> 전쟁 중: {{ team(warToday.attacker)?.name }} → {{ team(warToday.defender)?.name }}</strong> <span class="muted">(비용 {{ costText(warToday.cost) }})</span></div>
        <div class="muted">오프라인 게임 결과를 지정하세요. 결과가 나올 때까지 모든 거래와 단계 넘기기가 멈춥니다. 승·패·무승부를 넣으면 거래 단계가 끝나고 리더 협의로 넘어가요.</div>
        <div class="row" style="margin-top: 6px">
          <button class="danger" :disabled="busy" @click="askWar('attacker')">{{ team(warToday.attacker)?.name }} 승리</button>
          <button class="danger" :disabled="busy" @click="askWar('defender')">{{ team(warToday.defender)?.name }} 승리</button>
          <button class="secondary" :disabled="busy" @click="askWar('draw')">무승부</button>
          <button class="secondary" :disabled="busy" @click="askWar('cancel')">전쟁 취소</button>
        </div>
      </div>
      <p v-else-if="warToday">
        이번 라운드 전쟁: {{ team(warToday.attacker)?.name }} → {{ team(warToday.defender)?.name }} · <strong>{{ WAR_STATUS_LABELS[warToday.status] }}</strong>
        <span v-if="warToday.spoils" class="muted"> · 전리품 {{ offerText(warToday.spoils) }}</span>
      </p>
      <p v-else class="muted">이번 라운드에 선포된 전쟁 없음</p>
      <div v-if="!isLastDay" class="row war-cost">
        <span>{{ s.day + 1 }}라운드 선포 비용</span>
        <label v-for="k in WAR_COST_KINDS" :key="k">{{ RESOURCE_LABELS[k] }} <input v-model.number="nextCost[k]" type="number" min="0" /></label>
        <button class="secondary small" :disabled="busy" @click="saveNextCost">저장</button>
        <span v-if="view.war.nextCost" class="muted">저장됨: {{ costText(view.war.nextCost) }}</span>
        <span v-else class="blocker">아직 정하지 않음 — 정해야 다음 라운드로 넘어가요</span>
      </div>
    </template>

    <!-- 마지막 라운드 발행 단계 (docs/100 D4) -->
    <div v-if="s.status === 'running'" class="row war-cost">
      <span>마지막 라운드({{ s.totalDays }}라운드) 발행 단계</span>
      <template v-if="!isLastDay">
        <PhaseChecks v-model="lastPhases" :disabled="busy" />
        <button class="secondary small" :disabled="busy || !lastPhases.length || !lastPhasesDirty" @click="saveLastPhases">저장</button>
        <span class="muted">저장됨: {{ lastPhasesText(view.settings.lastIssuePhases) }} · 마지막 라운드가 시작되면 고정</span>
      </template>
      <strong v-else>{{ lastPhasesText(view.settings.lastIssuePhases) }} <span class="muted">(고정 · 발행량 비공개)</span></strong>
    </div>

    <!-- 이주 (docs/100 N3) -->
    <template v-if="s.status === 'running' && s.day >= migrationOpenFrom">
      <h3><Icon name="migration" /> 이주 <span class="muted">{{ migrationOpenFrom }}라운드부터 · 라이프 제출 단계 제외</span></h3>
      <p v-if="!view.migrations.pending.length" class="muted" style="margin: 0">대기 중인 이주 신청 없음</p>
      <table v-else class="tbl">
        <tbody>
          <tr v-for="m in view.migrations.pending" :key="m.id">
            <td><strong>{{ m.userName }}</strong></td>
            <td><TeamMark :color="team(m.fromTeamId)?.color ?? ''" />{{ team(m.fromTeamId)?.name }} → <TeamMark :color="team(m.toTeamId)?.color ?? ''" />{{ team(m.toTeamId)?.name }}</td>
            <td class="muted">받는 팀 리더 수락 대기</td>
            <td><button class="secondary small" :disabled="busy" @click="cancelMigration(m.id)">강제 취소</button></td>
          </tr>
        </tbody>
      </table>
      <details v-if="view.migrations.recent.length" style="margin-top: 6px">
        <summary class="muted">최근 처리 {{ view.migrations.recent.length }}건</summary>
        <ul class="feed">
          <li v-for="m in view.migrations.recent" :key="m.id">
            {{ m.day }}라운드 · {{ m.userName }} · {{ team(m.fromTeamId)?.name }} → {{ team(m.toTeamId)?.name }} ·
            <strong>{{ m.status === 'cancelled' ? (m.cancelReason ? MIGRATION_CANCEL_LABELS[m.cancelReason] : '취소') : MIGRATION_STATUS[m.status] }}</strong>
          </li>
        </ul>
      </details>
    </template>

    <!-- 리더간 협의 -->
    <template v-if="s.status === 'running' && s.phase === 'council'">
      <h3><Icon name="council" /> 리더 협의</h3>
      <p class="muted" style="margin: 0">
        <Icon name="aid" /> 대가 없는 원조는 아래 "팀 재화" 카드의 원조 입력으로 처리해요 (게임 전체 라운드당 1회{{ view.aidsToday.length ? ' · 이번 라운드 처리됨' : '' }}. 리더 4명 중 3명 찬성).
      </p>
      <div v-if="!isLastDay" class="life-vote" :class="{ missing: view.war.nextAllowed == null }" style="margin-top: 8px">
        <div><strong><Icon name="war" /> {{ s.day + 1 }}라운드 전쟁 허용 / 제재</strong></div>
        <div class="muted">제재면 다음 라운드에는 어느 팀도 전쟁을 선포할 수 없어요. 입력하지 않으면 허용이에요.</div>
        <div class="row" style="margin-top: 6px">
          <button :class="{ secondary: view.war.nextAllowed !== true }" :disabled="busy" @click="setWarAllowed(true)">허용</button>
          <button :class="{ secondary: view.war.nextAllowed !== false }" :disabled="busy" @click="setWarAllowed(false)">제재 (전쟁 금지)</button>
          <span v-if="view.war.nextAllowed == null" class="muted">아직 입력하지 않음 (허용으로 진행)</span>
          <span v-else class="muted">입력됨: <strong>{{ view.war.nextAllowed ? '허용' : '제재' }}</strong> (전체 공지됨)</span>
        </div>
      </div>
    </template>
    <div v-if="lifeVoteOpen" class="life-vote" :class="{ missing: s.lifeVote == null }">
      <div><strong><Icon name="scroll" /> 필수 안건: 남은 라이프를 최종 투표권으로 인정할까요?</strong></div>
      <div class="muted">리더 4명 중 3명 찬성이면 통과. 부결이면 최종 투표는 리더만 1표. 통과 시 팀 라이프 1개로 1표 (1인 1장): 리더는 1표 더, 팀원은 이것으로만 투표. 라이프 제출로 넘어가면 바꿀 수 없어요.</div>
      <div class="row" style="margin-top: 6px">
        <button :class="{ secondary: s.lifeVote !== true }" :disabled="busy" @click="setLifeVote(true)">통과</button>
        <button :class="{ secondary: s.lifeVote !== false }" :disabled="busy" @click="setLifeVote(false)">부결</button>
        <span v-if="s.lifeVote == null" class="blocker">아직 입력하지 않음</span>
        <span v-else class="muted">입력됨: <strong>{{ s.lifeVote ? '통과' : '부결' }}</strong> (전체 공지됨)</span>
      </div>
    </div>
    <p v-else-if="s.status === 'running' && isLastDay && s.phase === 'life'" class="muted">
      라이프 투표권 안건: <strong>{{ s.lifeVote ? '통과' : '부결' }}</strong>
    </p>

    <!-- 라이프 제출 -->
    <template v-if="s.status === 'running' && s.phase === 'life'">
      <h3>라이프 제출 <span v-if="s.livesDone" class="badge on">모든 팀 제출</span></h3>
      <table class="tbl">
        <tbody>
          <tr v-for="t in view.teams" :key="t.teamId">
            <td><TeamMark :color="team(t.teamId)?.color ?? ''" />{{ team(t.teamId)?.name }}</td>
            <td>
              <template v-if="t.lifeSubmission">
                제출 · 생존 {{ t.lifeSubmission.saved.map((id) => t.lifeSubmission!.names[id] ?? nameOf(id)).join(', ') }}
                <template v-if="t.lifeSubmission.livesUsed">(라이프 {{ t.lifeSubmission.livesUsed }})</template>
                <template v-else>(라이프 0 · 1명 생존)</template>
                <span v-if="t.lifeSubmission.selfEliminated" class="badge">리더 자진 탈락</span>
                <span v-if="t.lifeSubmission.eliminated.length" class="error"> · 탈락 {{ t.lifeSubmission.eliminated.map((id) => t.lifeSubmission!.names[id] ?? nameOf(id)).join(', ') }}</span>
              </template>
              <span v-else-if="t.activeMembers === 0" class="muted">활성 팀원 없음</span>
              <span v-else-if="isLifeExempt(t.activeMembers, t.resources.life)" class="muted">제출 불필요 · 팀원 1명 · 라이프 0 (자동 생존)</span>
              <span v-else class="muted">미제출 (라이프 {{ t.resources.life }} · 팀원 {{ t.activeMembers }}명)</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 최종장 (docs/100 N2) -->
    <FinalControl v-if="s.status === 'final' && s.final" :groups="groups" />
    <template v-else-if="s.status === 'ended' && s.final">
      <ResultsBoard :final="s.final" :results="s.results" />
      <div v-if="s.results" class="row" style="margin-top: 10px">
        <button class="secondary" @click="router.push('/prizes')">상금 계산</button>
      </div>
    </template>

    <template v-if="s.status === 'running'">
      <h3>초기 재화 합계 <span class="muted">(프레젠테이션 공개)</span></h3>
      <ResourceRow :amounts="s.initialTotals" />
    </template>

    <ModalDialog
      :open="modal !== null"
      :title="modalText.title"
      :message="modalText.message"
      :confirm-label="modal === 'reset' ? '리셋' : modal === 'end' ? '최종장 시작' : modal === 'start' ? '시작' : modal === 'war' ? '결과 확정' : modal === 'trade' ? '거래 진행' : '확인'"
      cancel-label="닫기"
      :danger="modal === 'reset' || modal === 'end' || modal === 'cancelTrade' || modal === 'war'"
      :busy="busy"
      @confirm="onConfirm"
      @cancel="modal = null"
    >
      <label v-if="modal === 'reset'" class="row clear-opt">
        <input v-model="clearSettings" type="checkbox" />
        게임 설정값(팀별 최대 인원·초기 재화)도 0 으로 초기화 (발행 한도는 기본값 250·200 으로)
      </label>
    </ModalDialog>
  </div>
</template>

<style scoped>
h3 { font-size: 0.95rem; margin: 16px 0 6px; font-weight: 600; }
.controls { align-items: center; }
.spacer { flex: 1; }
.tbl { border-collapse: collapse; font-size: 0.92rem; }
.tbl th, .tbl td { text-align: left; padding: 5px 12px 5px 0; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
.tbl th { color: var(--muted); font-weight: 500; font-size: 0.8rem; }
.letter { display: inline-block; min-width: 1.4em; font-weight: 600; }
.life-vote { margin-top: 8px; border: 1px solid var(--line); border-left: 4px solid var(--blue); border-radius: var(--radius); background: var(--bg-soft); padding: 10px 12px; }
.life-vote.missing { border-color: var(--red); border-left-color: var(--red); }
.war-active { border: 2px solid var(--red); border-left-width: 6px; border-radius: var(--radius); background: var(--red-bg); padding: 10px 12px; }
.war-active strong { color: var(--red); }
.war-cost { gap: 8px; align-items: center; margin-top: 6px; }
.war-cost input { width: 5em; padding: 3px 6px; }
.blocker { color: var(--red); font-size: 0.88rem; }
.trade { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.trade-form { display: flex; flex-direction: column; gap: 8px; }
.trade-form input[type="number"] { padding: 3px 6px; }
.offer-row { padding: 6px 10px; border: 1px solid var(--line-soft); border-left: 4px solid var(--team, var(--line)); border-radius: var(--radius); }
.offer-row .who { font-weight: 600; min-width: 9em; color: var(--team, var(--ink)); }
.team-select.picked { border: 2px solid var(--team); color: var(--team); font-weight: 700; background: color-mix(in srgb, var(--team) 12%, var(--surface)); }
button.small { padding: 4px 10px; font-size: 0.85rem; }
.reset-done { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: var(--radius); background: var(--bg-soft); line-height: 1.6; }
.reset-done button { margin-left: 8px; }
.clear-opt { gap: 8px; align-items: flex-start; flex-wrap: nowrap; font-size: 0.92rem; cursor: pointer; }
.clear-opt input { flex: none; margin-top: 3px; }
</style>
