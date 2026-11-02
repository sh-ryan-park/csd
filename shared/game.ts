/**
 * 게임 진행 정의 (서버/클라이언트 공용). 설계·결정 경위: docs/95.게임진행_설계.md
 * - 게임 상태: setup(설정) → ready(준비: 참가자 입장·팀 선택) → running(진행, day/phase) → final(최종장: 투표·결과·정산) → ended(끝)
 * - 라운드 흐름: 리더 선출 → 생산게임 → 거래 → 리더 협의 → 라이프 제출. 단계 전환은 관리자 버튼으로만.
 * - 용어: 화면·알림은 "N라운드" (코드·DB·API 의 day 는 그대로. docs/100 §5)
 */

export const RESOURCE_KINDS = ['gem', 'gold', 'life', 'credit'] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]
export type Resources = Record<ResourceKind, number>

export const RESOURCE_LABELS: Record<ResourceKind, string> = { gem: '보석', gold: '골드', life: '라이프', credit: '크레딧' }

export function emptyResources(): Resources {
  return { gem: 0, gold: 0, life: 0, credit: 0 }
}

export const PHASES = ['leader', 'production', 'trade', 'council', 'life'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_LABELS: Record<Phase, string> = {
  leader: '리더 선출',
  production: '생산게임',
  trade: '거래',
  council: '리더 협의',
  life: '라이프 제출',
}

export type GameStatus = 'setup' | 'ready' | 'running' | 'final' | 'ended'

/** 단계 타이머(초, docs/103 §14): 거래 15분 · 리더 협의 5분. 강제는 없고 0이 되면 전체에 "시간 종료" 알림 1회 */
export const PHASE_TIMER_SECONDS: Partial<Record<Phase, number>> = { trade: 15 * 60, council: 5 * 60 }
export const PHASE_TIMEOUT_MESSAGES: Partial<Record<Phase, string>> = { trade: '거래 시간이 종료되었어요.', council: '리더간 협의가 종료되었어요.' }

/** 진행 중 단계 타이머 (프레젠테이션 카운트다운용). 클라이언트는 serverNow 와 자기 시계의 차이로 보정한다 */
export interface PhaseTimer {
  phase: Phase
  /** 끝나는 시각 (ISO) */
  endsAt: string
  /** 서버 현재 시각 (ISO) */
  serverNow: string
  /** 전체 길이 (초) */
  seconds: number
  /** 이미 0 이 되어 알림을 보냈는지 */
  fired: boolean
}

/** 최종장 단계 (docs/100 N2): 최종 투표 → 결과 발표 → 정산 → 테러리스트 공개(N4) → 끝 */
export const FINAL_STEPS = ['vote', 'result', 'settle', 'spy'] as const
export type FinalStep = (typeof FINAL_STEPS)[number]
export const FINAL_STEP_LABELS: Record<FinalStep, string> = {
  vote: '최종 투표',
  result: '결과 발표',
  settle: '정산',
  spy: '테러리스트 공개',
}

/** 동점 가위바위보: 화이트 리더 승 = 보석, 옐로우 리더 승 = 골드 */
export type Tiebreak = 'white' | 'yellow'
export const TIEBREAK_ADOPTS: Record<Tiebreak, 'gem' | 'gold'> = { white: 'gem', yellow: 'gold' }

/** 최종장 공개 상태 (final·ended). 득표는 마감 뒤에만 */
export interface FinalState {
  step: FinalStep
  /** 투표한 사람 수 / 투표할 수 있는 사람 수 (활성 참가자) */
  votes: { done: number; eligible: number }
  closed: boolean
  /** 득표 (라이프 투표권 포함). 마감 뒤에만 */
  tally: { gem: number; gold: number } | null
  /** 마감했는데 동점이고 가위바위보 결과를 아직 넣지 않음 */
  tieUnresolved: boolean
  tiebreak: Tiebreak | null
  /** 채택 화폐 (마감·동점 처리 뒤) */
  adopted: 'gem' | 'gold' | null
  /** 마지막 라운드 발행량 — 결과 발표 단계부터 공개 */
  lastIssue: { gem: number; gold: number } | null
  /** 테러리스트 공개 (④ 단계부터). 테러리스트가 없으면 빈 배열 */
  spies: SpyStatus[] | null
}
/** 시작 전(설정·준비)에는 참가자가 게임 화면을 보지 못하고, 팀은 실제 이름 대신 A, B, C… 로 표시한다 */
export function isBeforeStart(status: GameStatus | null | undefined): boolean {
  return status === 'setup' || status === 'ready'
}

/** 팀 순서(0부터)로 A, B, C … Z, AA, AB … */
export function teamLetter(index: number): string {
  let n = index
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/** 준비 상태의 팀 선택 현황 (테스트 계정 제외) */
export interface LobbyTeam {
  teamId: number
  /** A, B, C … (팀 순서) */
  label: string
  count: number
  capacity: number
}

/** 프레젠테이션 팀 현황 (게임 시작 후). PIN·계정 id 는 담지 않는다 */
/** 오프닝 영상 파일명 (data/media 아래). 있으면 게임 시작 순간 프레젠테이션이 전체 화면으로 튼다 */
export const INTRO_FILE = 'intro.mp4'
export interface IntroResponse {
  /** /media/intro.mp4, 파일이 없으면 null */
  url: string | null
  size: number
}

export interface RosterTeam {
  teamId: number
  name: string
  color: string
  /** 리더 먼저, 그다음 id 순 */
  members: { name: string; isLeader: boolean; eliminated: boolean }[]
}

/** 모든 역할에 공개되는 게임 상태 */
export interface GameState {
  status: GameStatus
  /** 총 일수. 설정 전(또는 리셋 직후)은 null */
  totalDays: number | null
  /** 현재 일차 (1부터). setup 이면 0 */
  day: number
  phase: Phase | null
  /** 모든 팀 리더 선출 완료 (현재 일차) */
  leadersDone: boolean
  /** 모든 팀 라이프 제출 완료 (현재 일차) */
  livesDone: boolean
  /** 단계 타이머 (거래·리더 협의 단계에서만, docs/103 §14) */
  timer: PhaseTimer | null
  /** 모든 팀 초기 재화 합계 (프레젠테이션 공개용. 게임 중 변동은 공개하지 않는다) */
  initialTotals: Resources
  /** 정산 결과 (최종장 정산 단계부터) */
  results: GameResults | null
  /** 마지막 라운드 필수 안건 "남은 라이프를 최종 투표권으로" 결과. null = 아직 입력 안 함 (docs/100 N2) */
  lifeVote: boolean | null
  /** 최종장 (final·ended 일 때만) */
  final: FinalState | null
  /** 팀 선택 현황 (준비 상태에서만) */
  lobby: LobbyTeam[] | null
  /**
   * 게임 제목. 게임 시작 후에만 서버가 채운다 (시작 전 null → 프레젠테이션은 "스위칭데이").
   * 화면 코드에 넣으면 JS 파일로 미리 보이므로 서버에만 둔다 (server/src/db/game.ts GAME_TITLE)
   */
  title: string | null
  /** 전쟁 (진행 중일 때만 의미 있음). 모든 화면 상단 "전쟁 중" 띠, 거래 금지 표시에 쓴다 */
  war: PublicWarState
  /** 현황판 공개: 마지막 라운드 전까지 수락된 골드 발행 합계 (docs/100 D5). 시작 전은 null. 최종장 결과 발표부터 마지막 라운드 포함 */
  goldIssued: number | null
}

// ---- 전쟁 (docs/99.전쟁.md) ----

/** 선포 비용으로 낼 수 있는 재화 (보석·골드·크레딧). 일차마다 관리자가 정한다 */
export const WAR_COST_KINDS = ['gem', 'gold', 'credit'] as const
export type WarCost = Record<(typeof WAR_COST_KINDS)[number], number>
/** declared = 전쟁 중 (선포 즉시 시작, 2026-10-30 승인 단계 폐지 docs/103 §4). 결과는 관리자가 지정 */
export type WarStatus = 'declared' | 'attacker_won' | 'defender_won' | 'draw' | 'cancelled'
/** 관리자 결과 지정: 공격팀 승 / 방어팀 승 / 무승부 / 전쟁 취소 */
export type WarResult = 'attacker' | 'defender' | 'draw' | 'cancel'

export const WAR_STATUS_LABELS: Record<WarStatus, string> = {
  declared: '전쟁 중',
  attacker_won: '공격팀 승리',
  defender_won: '방어팀 승리',
  draw: '무승부',
  cancelled: '취소',
}

/** 모든 역할 공개 */
export interface PublicWarState {
  /** 진행 중 전쟁 (선포~결과). 이 동안 모든 팀 거래 금지 */
  active: { id: number; attacker: number; defender: number } | null
  /** 오늘 이미 선포됐는지 (하루 게임 전체 1회) */
  usedToday: boolean
  /** 오늘 선포 비용 (게임 진행 중에만) */
  cost: WarCost | null
  /** 오늘 전쟁 허용 여부 (리더 협의 결과, docs/103 §12). false 면 선포 불가 */
  allowed: boolean
  /** 다음 라운드 전쟁 허용/제재 (리더 협의 단계에 관리자가 입력. null = 아직 입력 안 함 → 허용). 프레젠테이션 협의 안건 표시용 */
  nextAllowed: boolean | null
  /** 오늘 전쟁 기록 (현황판 공개용, docs/100 D5). 전리품은 넣지 않는다 */
  today: { attacker: number; defender: number; status: WarStatus } | null
}

/** 관리자용 전쟁 기록. spoils 는 승리팀이 빼앗은 재화 (관리자·승리팀만 안다) */
export interface WarView {
  id: number
  day: number
  attacker: number
  defender: number
  status: WarStatus
  cost: WarCost
  spoils: Resources | null
  createdAt: string
  decidedAt: string | null
}

/** 패배팀 재화의 절반(내림)을 빼앗는다 */
export function warSpoils(loser: Resources): Resources {
  const out = emptyResources()
  for (const k of RESOURCE_KINDS) out[k] = Math.floor(loser[k] / 2)
  return out
}

/** 게임 설정 (관리자). setup·ready 상태에서 수정 */
export interface GameSettings {
  totalDays: number | null
  /** teamId → 최대 인원 (테스트 계정 제외). 초기셋팅완료 때 합계만큼 팀 없는 PIN 을 만든다 */
  capacity: Record<number, number>
  /** 팀별 테스트 계정(시드 리더·팀원) 포함 여부. 미포함이면 비활성 처리돼 게임에서 빠진다 */
  includeTest: boolean
  /** teamId → 초기 재화 */
  initial: Record<number, Resources>
  /** 일차당 발행 한도 (보석: 이월 없음, 골드: 안 쓴 만큼 이월) */
  issueLimit: IssueLimits
  /** 1일차 전쟁 선포 비용 (설정 전이면 null — 시작 조건) */
  warCost: WarCost | null
  /** 마지막 라운드에 발행을 허용할 단계 (docs/100 D4). 마지막 라운드가 시작되면 고정 */
  lastIssuePhases: Phase[]
  /** 테스트 모드(탭 로그인, docs/101). 켜면 리프레시 쿠키 없이 탭마다 로그인. 언제든 전환 */
  tabLogin: boolean
  /** 이주가 열리는 라운드 (docs/100 N3, 기본 4). 총 라운드보다 크면 이주 없음 */
  migrationStartDay: number
}

// ---- 테러리스트 (docs/100 N4) ----

/** 운명의 카드: moon = 악마 = 테러리스트 후보, sun = 천사 = 후보 아님 (2026-11-02 태양/달 → 천사/악마, 내부 값은 그대로) */
export type Fate = 'sun' | 'moon'
export const FATE_LABELS: Record<Fate, string> = { sun: '천사', moon: '악마' }
/** 시작 이후 탈락자 1명당 적립, 최대 (룰 03 §12) */
export const SPY_REWARD_PER = 5000
export const SPY_REWARD_MAX = 50000

export function spyReward(eliminated: number, alive: boolean): number {
  return alive ? Math.min(eliminated * SPY_REWARD_PER, SPY_REWARD_MAX) : 0
}

/** 테러리스트 1명의 현황. 본인 화면(카드)·관리자·최종장 공개에 쓴다 */
export interface SpyStatus {
  userId: number
  name: string
  teamId: number | null
  /** 본인이 살아 있는지 (탈락하면 적립금 0) */
  alive: boolean
  /** 시작 이후 탈락자 수 (본인 제외) */
  eliminated: number
  reward: number
}

/** 관리자 화면 (준비 상태: 후보 지정 / 진행 중: 현황) */
export interface AdminSpyView {
  counts: { sun: number; moon: number; none: number }
  /** 악마를 고른 활성 참가자 (팀이 있는 사람) */
  candidates: { userId: number; name: string; teamId: number; isTest: boolean }[]
  /** 지정된 테러리스트 id */
  selected: number[]
  /** 진행 중·최종장: 테러리스트 현황 */
  spies: SpyStatus[]
}

// ---- 이주 (docs/100 N3) ----

export type MigrationStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled'
/** 취소 사유: 본인 / 관리자 / 신청자가 리더가 됨 / 탈락 / 다른 경로로 팀이 바뀜 */
export type MigrationCancelReason = 'self' | 'admin' | 'leader' | 'inactive' | 'moved'
export const MIGRATION_CANCEL_LABELS: Record<MigrationCancelReason, string> = {
  self: '본인 취소',
  admin: '진행자 취소',
  leader: '리더가 되어 자동 취소',
  inactive: '탈락으로 자동 취소',
  moved: '팀이 바뀌어 자동 취소',
}
export const DEFAULT_MIGRATION_START_DAY = 4

export interface MigrationView {
  id: number
  day: number
  userId: number
  userName: string
  fromTeamId: number
  toTeamId: number
  status: MigrationStatus
  cancelReason: MigrationCancelReason | null
  createdAt: string
  decidedAt: string | null
}

/** 참가자 화면용 이주 정보 */
export interface TeamMigrationView {
  /** 지금 신청·수락할 수 있는지 (진행 중 · 이주 시작 라운드부터 · 라이프 제출 단계 제외) */
  open: boolean
  startDay: number
  /** 내 대기 신청 (일반 팀원) */
  mine: MigrationView | null
  /** 이미 끝난 내 이주 (수락됨). 이주는 1인 1회라 있으면 다시 신청할 수 없다 */
  done: MigrationView | null
  /** 우리 팀으로 온 대기 신청 (리더에게만) */
  incoming: MigrationView[]
}

/** 이주를 신청·수락할 수 있는 때 */
export function isMigrationOpen(status: GameStatus, day: number, phase: Phase | null, startDay: number): boolean {
  return status === 'running' && day >= startDay && phase !== 'life'
}

/** 정산 팀 행 (docs/100 D7, 룰 03 §11) */
export interface TeamShare {
  teamId: number
  name: string
  color: string
  /** 살아남은 인원 (활성 팀원) */
  alive: number
  /** 보유한 채택 화폐 */
  holding: number
  /** 보상 비율 0~1 */
  share: number
  /** 상대 화폐 발행팀 (보석 채택 → 옐로우, 골드 채택 → 화이트): 보상 없음, 분모에서도 제외 */
  excluded: boolean
}

export interface GameResults {
  adopted: 'gem' | 'gold'
  teams: TeamShare[]
  publishedAt: string
}

// ---- 상금 계산 (관리자 /prizes). 금액·규칙은 서버 prize.ts 에만 있다 ----

/** 상금을 받는 칸: 등수별 팀 또는 탈락자 전체 */
export interface PrizeColumn {
  /** 1등~4등, 탈락 */
  label: string
  /** 탈락 칸은 null */
  teamId: number | null
  name: string
  color: string
  people: number
}

export interface PrizeCell {
  /** 인별 금액 */
  each: number
  /** 팀 총합 */
  total: number
  /** 위 등수보다 인별 금액이 많다 */
  eachFlip: boolean
  /** 위 등수보다 팀 총합이 많다 (탈락 칸은 보지 않는다) */
  totalFlip: boolean
}

export interface PrizePlan {
  /** 분배 방식 이름 */
  name: string
  rule: string
  /** 예외로 계산한 판의 표시 */
  note: string
  /** columns 와 같은 순서. 계산할 수 없는 방식은 null */
  cells: PrizeCell[] | null
  /** 잔액 = 총액 − 팀 총합의 합 */
  left: number | null
  /** 총 지출 = 팀 총합의 합 + 테러리스트 보상 */
  spend: number | null
}

export interface PrizeSpy extends SpyStatus {
  /** 소속 칸 (columns 번호). 탈락했으면 탈락 칸, 찾지 못하면 null */
  column: number | null
}

export interface PrizeView {
  /** 상금 총액 */
  total: number
  /** 인별 금액 단위. 이 금액 미만은 버린다 */
  unit: number
  /** 발표된 정산. 없으면 계산할 수 없다 */
  results: GameResults | null
  /** 시작 이후 탈락자 수 */
  dead: number
  columns: PrizeColumn[]
  plans: PrizePlan[]
  spies: PrizeSpy[]
  /** 진행자가 확인할 점 */
  warnings: string[]
}

// ---- 리더 선출 (팀원 전원 투표) ----

/** 리더 선정 (진행자 수동 지정, docs/100 §7-6). pending: 지정 대기 · done: 지정 완료(자동 포함) */
export type ElectionStatus = 'pending' | 'done'

export interface ElectionView {
  status: ElectionStatus
  /** 결과 리더 (done). 지정 전에 단계를 넘기면 현 리더 */
  leaderId: number | null
}

// ---- 거래 ----

/**
 * 거래 (2026-10-30 docs/103 §10): 오프라인 협의 → 진행자가 내용을 입력해 "거래 진행" (proposed) → 두 팀 리더가 각각 수락하면 completed
 * (크레딧 1개 차감 + 재화 교환). 한쪽이라도 거부하면 rejected. 관리자 강제 취소·단계 종료는 cancelled
 */
export type TradeStatus = 'proposed' | 'completed' | 'rejected' | 'cancelled'
export const ACTIVE_TRADE_STATUSES: readonly TradeStatus[] = ['proposed']

export interface TradeSide {
  teamId: number
  /** 이 팀이 상대에게 주는 재화 (진행자가 입력) */
  offer: Resources
  /** 이 팀 리더가 수락했는지 */
  accepted: boolean
}

export interface TradeView {
  id: number
  day: number
  status: TradeStatus
  from: TradeSide
  to: TradeSide
  /** 크레딧(수수료 1개)을 내는 팀 */
  creditPayer: number
  /** 거부한 팀 (rejected 일 때) */
  closedBy: number | null
  updatedAt: string
}

// ---- 라이프 제출 ----

/**
 * 활성 팀원이 1명만 남은 팀은 라이프 제출이 없다 (자동 생존, 라이프 소모 없음). 인원은 그 시점 기준이라
 * 제출 단계 도중에 1명이 되면 바로 제출 불필요로 바뀐다. 0명인 팀은 제출할 사람이 없어 완료로 본다.
 */
/**
 * 라이프 제출이 필요 없는 팀: 활성 팀원 1명이고 라이프가 0개 (자동 생존, 탈락 없음. docs/103 §8).
 * 1명이라도 라이프가 있으면 제출해야 한다 (1명 생존 = 라이프 1개 소모)
 */
export function isLifeExempt(activeMembers: number, lives: number): boolean {
  return activeMembers === 1 && lives === 0
}

/**
 * 라이프 제출로 살릴 수 있는 최대 인원 (= 쓸 수 있는 라이프 최대). 최소는 1.
 * 자진 탈락이면 리더를 뺀 팀원 수까지. 라이프가 0개면 0 (숫자 입력 없이 1명만 생존, 라이프 소모 없음)
 */
export function lifeSubmitMax(activeMembers: number, lives: number, selfEliminate: boolean): number {
  return Math.max(0, Math.min(lives, selfEliminate ? activeMembers - 1 : activeMembers))
}

export interface LifeSubmissionView {
  saved: number[]
  eliminated: number[]
  /** 생존자·탈락자 이름 (id → 이름). 탈락자는 활성 팀원 목록에서 빠지므로 화면이 이것으로 이름을 그린다 */
  names: Record<number, string>
  livesUsed: number
  /** 리더 자진 탈락 (리더 외 팀원 중 무작위로 생존자를 정함) */
  selfEliminated: boolean
  createdAt: string
}

// ---- 보석·골드 발행 (docs/97.보석골드_발행.md) ----

export type IssueKind = 'gem' | 'gold'
export type IssueLimits = Record<IssueKind, number>
export const DEFAULT_ISSUE_LIMITS: IssueLimits = { gem: 250, gold: 200 }

/** 발행 요청을 할 수 있는 팀 (groups.code). 팀 이름·색을 바꿔도 code 는 그대로다 */
export const ISSUE_TEAM_CODE: Record<IssueKind, string> = { gem: 'white', gold: 'yellow' }

export function issueKindOfTeam(code: string | null | undefined): IssueKind | null {
  if (code === ISSUE_TEAM_CODE.gem) return 'gem'
  if (code === ISSUE_TEAM_CODE.gold) return 'gold'
  return null
}

/** 마지막 라운드 발행 허용 단계 기본값: 룰의 "리더 협의 뒤" = 라이프 제출 */
export const DEFAULT_LAST_ISSUE_PHASES: readonly Phase[] = ['life']

/** 단계 목록을 PHASES 순서로 정리 (중복 제거) */
export function sortPhases(phases: readonly Phase[]): Phase[] {
  return PHASES.filter((p) => phases.includes(p))
}

export type IssueStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  pending: '수락 대기',
  approved: '수락됨',
  rejected: '거절됨',
  cancelled: '취소됨',
}

export interface IssueRequestView {
  id: number
  day: number
  teamId: number
  kind: IssueKind
  amount: number
  status: IssueStatus
  requestedBy: number | null
  requestedByName: string | null
  createdAt: string
  decidedAt: string | null
}

/**
 * 남은 발행 가능량. used = 대기 중 + 수락된 수량.
 * - 보석: 이번 일차 한도 − 이번 일차 사용량
 * - 골드: 한도 × 지금까지 일차 수 − 전체 사용량 (안 쓴 만큼 다음 일차로 이월)
 */
export function issueRemaining(kind: IssueKind, limit: number, day: number, used: { today: number; total: number }): number {
  const cap = kind === 'gem' ? limit - used.today : limit * day - used.total
  return Math.max(0, cap)
}

/** 화이트·옐로우팀 화면의 발행 정보 (그 팀만) */
export interface TeamIssueView {
  kind: IssueKind
  /** 지금 단계에서 요청할 수 있는지. 진행 중이면 모든 단계, 마지막 라운드는 관리자가 정한 단계만 (리더 여부·대기 요청·이번 라운드 발행은 따로) */
  open: boolean
  /** 마지막 라운드일 때만: 발행 허용 단계 (안내용). 마지막 라운드 발행량은 공개되지 않는다 */
  lastRoundPhases: Phase[] | null
  /** 이번 라운드(일차)에 발행했는지. 라운드당 1회라 있으면 더 요청할 수 없다 */
  issuedToday: boolean
  /** 이번 일차 남은 발행 가능량 */
  remaining: number
  /** 최근 발행 (최신순) */
  recent: IssueRequestView[]
}

/** 팀원 화면용 (자기 팀만) */
export interface TeamGameView {
  resources: Resources
  election: ElectionView | null
  lifeSubmission: LifeSubmissionView | null
  /** 내 팀이 참여한 진행 중 거래 */
  trade: TradeView | null
  /** 화이트(보석)·옐로우(골드)팀만 */
  issue: TeamIssueView | null
  /** 내 최종 투표 (최종장, 본인만) */
  /** weight = 득표 (리더 기본 1 + 라이프 투표권 1). 팀원은 라이프 투표권으로만 투표하므로 1 */
  myFinalVote: { choice: 'gem' | 'gold'; extra: boolean; weight: number } | null
  /** 이주 (진행 중에만) */
  migration: TeamMigrationView | null
  /** 내가 테러리스트면 현황 (본인에게만. 아니면 null) */
  spy: SpyStatus | null
}

/** 관리자 화면용 팀 행 */
export interface AdminTeamRow {
  teamId: number
  resources: Resources
  initial: Resources
  activeMembers: number
  election: ElectionView | null
  lifeSubmission: LifeSubmissionView | null
}

export interface LedgerEntry {
  id: number
  teamId: number
  kind: ResourceKind
  delta: number
  amountAfter: number
  reason: LedgerReason
  day: number
  createdAt: string
}

export type LedgerReason = 'init' | 'production' | 'correction' | 'aid' | 'trade' | 'trade_credit' | 'life' | 'issue' | 'war_cost' | 'war_loss' | 'war_spoils' | 'final_vote'

export const LEDGER_REASON_LABELS: Record<LedgerReason, string> = {
  init: '초기 설정',
  production: '생산',
  correction: '정정',
  aid: '원조',
  trade: '거래',
  trade_credit: '거래 크레딧',
  life: '라이프 제출',
  issue: '발행',
  war_cost: '전쟁 비용',
  war_loss: '전쟁 패배',
  war_spoils: '전쟁 전리품',
  final_vote: '라이프 투표권',
}

/** 리더간 협의 원조 1건 */
export interface CouncilAidView {
  fromTeamId: number
  toTeamId: number
  amounts: Resources
}

export interface AdminGameView {
  state: GameState
  settings: GameSettings
  teams: AdminTeamRow[]
  /** 이번 라운드 원조 (게임 전체 라운드당 1회, docs/103 §11). 진행 중이 아니면 빈 배열 */
  aidsToday: CouncilAidView[]
  trade: TradeView | null
  ledger: LedgerEntry[]
  /** 시작 전 점검 (준비 상태) */
  prep: {
    /** 팀을 고르지 않은 활성 참가자 (시작하면 비활성) */
    unassigned: number
  }
  /** 보석·골드 발행 */
  issues: {
    /** 최근 발행 (최신순). 요청 즉시 자동 발행 (docs/103 §9) */
    recent: IssueRequestView[]
    /** 이번 일차 남은 발행 가능량 (해당 팀이 없으면 null) */
    remaining: Record<IssueKind, number | null>
    /** 이번 라운드에 수락된 발행이 있는지 (라운드당 1회) */
    issuedToday: Record<IssueKind, boolean>
    /** 마지막 라운드일 때만: 그 라운드에 수락된 발행량 (비공개, 관리자 전용) */
    lastRound: Record<IssueKind, number> | null
  }
  /** 전쟁 */
  war: {
    /** 오늘 전쟁 기록 (진행 중이거나 끝난 것) */
    today: WarView | null
    /** 오늘 선포 비용 */
    todayCost: WarCost | null
    /** 다음 날 선포 비용 (입력해야 다음 날로 넘어간다. 마지막 날에는 필요 없음) */
    nextCost: WarCost | null
    /** 오늘 전쟁 허용 여부 (리더 협의 결과) */
    todayAllowed: boolean
    /** 다음 라운드 전쟁 허용/제재. null = 아직 입력 안 함 (→ 허용) */
    nextAllowed: boolean | null
  }
  /** 최종 투표 팀별 진행 (최종장). 득표는 state.final.tally (마감 뒤) */
  finalVotes: { teamId: number; done: number; eligible: number }[]
  /** 이주: 대기 신청(오래된 순) · 최근 처리(최신순) */
  migrations: { pending: MigrationView[]; recent: MigrationView[] }
  /** 테러리스트 (운명의 카드 현황·후보·지정·적립) */
  spy: AdminSpyView
}

export function isResources(v: unknown): v is Resources {
  return !!v && typeof v === 'object' && RESOURCE_KINDS.every((k) => Number.isInteger((v as Record<string, unknown>)[k]))
}

export function sumResources(list: Resources[]): Resources {
  const total = emptyResources()
  for (const r of list) for (const k of RESOURCE_KINDS) total[k] += r[k]
  return total
}

/**
 * 정산 (docs/100 D7, 룰 03 §11): 팀 보상 = 팀 보유 채택 화폐 ÷ 모든 팀 보유 채택 화폐.
 * - 상대 화폐 발행팀(보석 채택 → 옐로우, 골드 채택 → 화이트)은 보상 0, 분모에서도 제외
 * - 살아남은 인원 0명 팀은 보상 0 이지만 분모에는 남는다 (그 몫은 아무도 가져가지 않는다)
 * - 분모가 0 이면 모두 0
 */
export function settleShares(
  teams: { teamId: number; code: string; name: string; color: string; alive: number; resources: Resources }[],
  adopted: 'gem' | 'gold',
): TeamShare[] {
  const excludedCode = adopted === 'gem' ? ISSUE_TEAM_CODE.gold : ISSUE_TEAM_CODE.gem
  const rows = teams.map((t) => ({ ...t, holding: t.resources[adopted], excluded: t.code === excludedCode }))
  const denom = rows.filter((t) => !t.excluded).reduce((sum, t) => sum + t.holding, 0)
  return rows.map((t) => ({
    teamId: t.teamId,
    name: t.name,
    color: t.color,
    alive: t.alive,
    holding: t.excluded ? 0 : t.holding,
    share: t.excluded || t.alive === 0 || denom === 0 ? 0 : t.holding / denom,
    excluded: t.excluded,
  }))
}

/** 보상 % 표시 (소수 첫째 자리) */
export function shareText(share: number): string {
  return `${(Math.round(share * 1000) / 10).toLocaleString('ko-KR')}%`
}

/**
 * 받침에 맞는 조사를 붙인다. josa('옐로우 팀', '이/가') → '옐로우 팀이', josa('화이트', '와/과') → '화이트와'.
 * 한글로 끝나지 않으면 '이(가)' 처럼 둘 다 표시.
 */
export function josa(word: string, pair: '이/가' | '을/를' | '은/는' | '와/과'): string {
  const [withFinal, withoutFinal] = pair.split('/') as [string, string]
  const code = word.charCodeAt(word.length - 1) - 0xac00
  if (code < 0 || code > 11171) return `${word}${withFinal}(${withoutFinal})`
  return word + (code % 28 !== 0 ? withFinal : withoutFinal)
}
