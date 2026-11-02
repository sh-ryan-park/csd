/**
 * 최종장 (docs/100.최종룰_차이_결정사항.md N2 + D7, 룰 03 §11).
 *   running(마지막 라운드 협의: 라이프 투표권 안건 통과/부결)
 *     └─게임 종료──▶ final/vote ──마감(+동점이면 가위바위보)──▶ final/result ──▶ final/settle ──▶ final/spy(테러리스트 공개, N4) ──▶ ended
 *
 * 규칙:
 * - 투표: 활성 참가자(테러리스트·테스트 계정 포함, 탈락자 제외) 1인 1회, 보석/골드. 한 번 내면 바꿀 수 없다 (final_votes PRIMARY KEY)
 * - 기본 1표는 리더만 (2026-10-30 결정, final_votes.base). 안건 부결이면 리더만 투표한다
 * - 라이프 투표권: 안건 통과 시 팀 라이프 1개로 1표(extra), 즉시 차감 (선착순, 1인 1장). 리더는 기본표에 더하고(2표), 일반 팀원은 이것으로만 투표한다(1표).
 *   투표 기록과 차감은 한 트랜잭션
 * - 득표는 마감 전에는 아무도(관리자 포함) 볼 수 없고 인원 현황만 공개. 미투표자는 기권
 * - 동점이면 관리자가 가위바위보 결과(화이트 승 = 보석 / 옐로우 승 = 골드)를 넣어야 결과 발표로 넘어간다
 * - 결과 발표 단계부터 마지막 라운드 발행량(보석·골드)을 공개한다
 * - 단계 진행은 `UPDATE … WHERE final_step = ?` 의 changes 로 판정 → 관리자 두 명이 동시에 눌러도 한 번만 넘어간다
 */
import { db } from './index.js'
import { listGroupMembers, listGroups } from './users.js'
import { applyDeltas, getAllResources } from './resources.js'
import { lastRoundAmounts } from './issuance.js'
import { eliminatedCount, listSpyStatus } from './spy.js'
import { GameError } from './gameError.js'
import { computePrizes, PRIZE_TOTAL, PRIZE_UNIT } from '../prize.js'
import { emptyResources, settleShares, TIEBREAK_ADOPTS } from '../../../shared/game.js'
import type { FinalState, FinalStep, GameResults, Phase, PrizeView, SpyStatus, Tiebreak } from '../../../shared/game.js'

type Choice = 'gem' | 'gold'

/** game.ts 가 이 모듈을 불러 쓰므로 순환 import 를 피해 필요한 열만 직접 읽는다 */
interface FinalRow {
  status: string
  day: number
  phase: Phase | null
  total_days: number | null
  final_step: FinalStep | null
  life_vote_passed: 0 | 1 | null
  votes_closed: number
  tiebreak: Tiebreak | null
  adopted: Choice | null
}

function getRow(): FinalRow {
  return db.prepare('SELECT status, day, phase, total_days, final_step, life_vote_passed, votes_closed, tiebreak, adopted FROM game WHERE id = 1').get() as FinalRow
}

function update(set: string, params: unknown[] = []): number {
  return db.prepare(`UPDATE game SET ${set}, updated_at = datetime('now') WHERE id = 1`).run(...params).changes
}

function requireFinal(step?: FinalStep): FinalRow {
  const r = getRow()
  if (r.status !== 'final') throw new GameError('not_final', '최종장이 아니에요')
  if (step && r.final_step !== step) throw new GameError('wrong_step', '지금은 할 수 없는 단계예요. 화면을 새로고침하세요')
  return r
}

// ---- 마지막 라운드 안건 ----

/** 라이프 투표권 안건 결과. 마지막 라운드 리더 협의 단계에서만, 그 단계 안에서는 고칠 수 있다 */
export function setLifeVote(passed: boolean) {
  const r = getRow()
  if (r.status !== 'running') throw new GameError('not_running', '게임이 진행 중이 아니에요')
  if (r.day < (r.total_days ?? Infinity) || r.phase !== 'council') {
    throw new GameError('wrong_phase', '라이프 투표권 안건은 마지막 라운드 리더 협의 단계에서 입력해요')
  }
  update('life_vote_passed = ?', [passed ? 1 : 0])
}

export function getLifeVote(): boolean | null {
  const v = getRow().life_vote_passed
  return v == null ? null : v === 1
}

// ---- 투표 ----

/** 팀별 투표 진행. eligible = 안건 통과면 활성 팀원 수, 부결이면 리더 수(0~1) (최종장에는 탈락·이주가 없다) */
export function finalVoteProgress(): { teamId: number; done: number; eligible: number }[] {
  const passed = getRow().life_vote_passed === 1
  const done = new Map(
    (db.prepare('SELECT group_id, COUNT(*) AS n FROM final_votes GROUP BY group_id').all() as { group_id: number; n: number }[]).map((r) => [r.group_id, r.n]),
  )
  return listGroups().map((t) => {
    const members = listGroupMembers(t.id)
    return { teamId: t.id, done: done.get(t.id) ?? 0, eligible: passed ? members.length : members.filter((m) => m.isLeader).length }
  })
}

function tally(): { gem: number; gold: number } {
  const rows = db.prepare('SELECT choice, SUM(base + extra) AS n FROM final_votes GROUP BY choice').all() as { choice: Choice; n: number }[]
  return { gem: rows.find((r) => r.choice === 'gem')?.n ?? 0, gold: rows.find((r) => r.choice === 'gold')?.n ?? 0 }
}

export function getMyFinalVote(userId: number): { choice: Choice; extra: boolean; weight: number } | null {
  const r = db.prepare('SELECT choice, extra, base FROM final_votes WHERE user_id = ?').get(userId) as { choice: Choice; extra: number; base: number } | undefined
  return r ? { choice: r.choice, extra: r.extra === 1, weight: r.base + r.extra } : null
}

/**
 * 투표 1회. extra = 라이프 투표권 사용 (안건 통과 시, 팀 라이프 1개).
 * 리더: 기본 1표 (+ extra). 일반 팀원: 안건 통과 시 extra 로만 1표, 부결이면 투표 불가. 반환: 투표한 사람의 팀과 득표
 */
export function castFinalVote(userId: number, choice: Choice, extra: boolean): { teamId: number; weight: number } {
  return db.transaction(() => {
    const r = requireFinal('vote')
    if (r.votes_closed) throw new GameError('votes_closed', '투표가 마감되었어요')
    const u = db.prepare(`SELECT group_id, is_leader FROM users WHERE id = ? AND role = 'member' AND active = 1`).get(userId) as
      | { group_id: number | null; is_leader: number }
      | undefined
    if (!u?.group_id) throw new GameError('not_eligible', '투표할 수 없는 계정이에요', 403)
    const leader = u.is_leader === 1
    const passed = r.life_vote_passed === 1
    if (extra && !passed) throw new GameError('no_life_vote', '라이프 투표권 안건이 통과되지 않았어요')
    if (!leader && !passed) throw new GameError('leader_only', '라이프 투표권 안건이 부결되어 리더만 투표해요', 403)
    if (!leader && !extra) throw new GameError('life_required', '팀원은 라이프 투표권(팀 라이프 1개)으로만 투표할 수 있어요', 400)
    const base = leader ? 1 : 0
    const ok = db.prepare('INSERT OR IGNORE INTO final_votes (user_id, group_id, choice, extra, base) VALUES (?, ?, ?, ?, ?)')
      .run(userId, u.group_id, choice, extra ? 1 : 0, base).changes === 1
    if (!ok) throw new GameError('already_voted', '이미 투표했어요')
    if (extra) {
      try {
        applyDeltas(u.group_id, { life: -1 }, { reason: 'final_vote', day: r.day, by: userId })
      } catch (e) {
        if (e instanceof GameError && e.code === 'insufficient') throw new GameError('no_life', '팀 라이프가 남아 있지 않아 라이프 투표권을 쓸 수 없어요')
        throw e
      }
    }
    return { teamId: u.group_id, weight: base + (extra ? 1 : 0) }
  })()
}

/** 투표 마감. 미투표자는 기권. 동점이면 채택 화폐는 가위바위보 입력 뒤 */
export function closeFinalVotes(): { gem: number; gold: number; tie: boolean; notVoted: number } {
  return db.transaction(() => {
    const r = requireFinal('vote')
    if (r.votes_closed) throw new GameError('votes_closed', '이미 마감했어요')
    const t = tally()
    const tie = t.gem === t.gold
    update('votes_closed = 1, adopted = ?', [tie ? null : t.gem > t.gold ? 'gem' : 'gold'])
    const progress = finalVoteProgress()
    const notVoted = progress.reduce((sum, p) => sum + Math.max(0, p.eligible - p.done), 0)
    return { ...t, tie, notVoted }
  })()
}

/** 동점 가위바위보 결과. 마감 뒤 결과 발표 전까지 (잘못 넣었으면 다시 넣을 수 있다) */
export function setTiebreak(winner: Tiebreak): Choice {
  return db.transaction(() => {
    const r = requireFinal('vote')
    if (!r.votes_closed) throw new GameError('votes_open', '투표를 먼저 마감하세요')
    const t = tally()
    if (t.gem !== t.gold) throw new GameError('no_tie', '동점이 아니에요')
    const adopted = TIEBREAK_ADOPTS[winner]
    update('tiebreak = ?, adopted = ?', [winner, adopted])
    return adopted
  })()
}

// ---- 단계 진행 ----

/** 정산 계산 (D7). 살아남은 인원 = 활성 팀원 */
function computeResults(adopted: Choice): GameResults {
  const { amount } = getAllResources()
  const teams = listGroups().map((t) => ({
    teamId: t.id,
    code: t.code,
    name: t.name,
    color: t.color,
    alive: listGroupMembers(t.id).length,
    resources: amount.get(t.id) ?? emptyResources(),
  }))
  return { adopted, teams: settleShares(teams, adopted), publishedAt: new Date().toISOString() }
}

export type FinalAdvance =
  | { to: 'result'; adopted: Choice; tally: { gem: number; gold: number }; tiebreak: Tiebreak | null; lastIssue: { gem: number; gold: number } }
  | { to: 'settle'; results: GameResults }
  | { to: 'spy'; spies: SpyStatus[] }
  | { to: 'ended' }

/** 다음 단계로. expect = 관리자 화면이 보고 있던 단계 (중복 클릭·동시 조작 방지) */
export function advanceFinal(expect: FinalStep): FinalAdvance {
  return db.transaction((): FinalAdvance => {
    const r = requireFinal()
    if (r.final_step !== expect) throw new GameError('stale', '이미 다음 단계로 넘어갔어요. 화면을 새로고침하세요')
    const step = (to: FinalStep) => {
      if (db.prepare(`UPDATE game SET final_step = ?, updated_at = datetime('now') WHERE id = 1 AND final_step = ?`).run(to, expect).changes !== 1) {
        throw new GameError('stale', '이미 다음 단계로 넘어갔어요')
      }
    }
    if (expect === 'vote') {
      if (!r.votes_closed) throw new GameError('votes_open', '투표를 먼저 마감하세요')
      if (!r.adopted) throw new GameError('tie_unresolved', '동점이에요. 가위바위보 결과를 넣으세요')
      step('result')
      return { to: 'result', adopted: r.adopted, tally: tally(), tiebreak: r.tiebreak, lastIssue: lastRoundAmounts(r.total_days ?? r.day) }
    }
    if (expect === 'result') {
      const results = computeResults(r.adopted!)
      step('settle')
      update('results = ?', [JSON.stringify(results)])
      return { to: 'settle', results }
    }
    if (expect === 'settle') {
      step('spy')
      return { to: 'spy', spies: listSpyStatus() }
    }
    // 테러리스트 공개 → 끝
    update(`status = 'ended', ended_at = datetime('now')`)
    return { to: 'ended' }
  })()
}

/** 정산 다시 계산 (정산 단계에서 관리자가 재화를 정정한 경우) */
export function recomputeResults(): GameResults {
  return db.transaction(() => {
    const r = requireFinal('settle')
    const results = computeResults(r.adopted!)
    update('results = ?', [JSON.stringify(results)])
    return results
  })()
}

/** 상금 계산 화면 (관리자). 발표된 정산 값으로 계산하고, 그 뒤 재화·인원이 바뀌었으면 알린다 */
export function getPrizeView(): PrizeView {
  const r = db.prepare('SELECT final_step, results FROM game WHERE id = 1').get() as { final_step: FinalStep | null; results: string | null }
  const dead = eliminatedCount()
  if (!r.results) return { total: PRIZE_TOTAL, unit: PRIZE_UNIT, results: null, dead, columns: [], plans: [], spies: [], warnings: [] }
  const results = JSON.parse(r.results) as GameResults
  const spies = listSpyStatus()
  const { columns, plans, warnings } = computePrizes(results.teams, dead, spies.reduce((sum, s) => sum + s.reward, 0))
  const now = new Map(computeResults(results.adopted).teams.map((t) => [t.teamId, t]))
  if (results.teams.some((t) => t.alive !== now.get(t.teamId)?.alive || t.holding !== now.get(t.teamId)?.holding)) {
    warnings.unshift(`정산 발표 뒤 팀 재화나 인원이 바뀌었어요. 이 화면은 발표된 정산 값으로 계산해요.${r.final_step === 'settle' ? ' 최종장 정산의 "다시 계산"을 누르면 반영돼요.' : ''}`)
  }
  return {
    total: PRIZE_TOTAL,
    unit: PRIZE_UNIT,
    results,
    dead,
    columns,
    plans,
    spies: spies.map((s) => {
      const column = columns.findIndex((c) => c.teamId === (s.alive ? s.teamId : null))
      return { ...s, column: column < 0 ? null : column }
    }),
    warnings,
  }
}

// ---- 공개 상태 ----

const STEP_ORDER: readonly FinalStep[] = ['vote', 'result', 'settle', 'spy']

/** 결과 발표 단계 이후인지 (마지막 라운드 발행량 공개 기준) */
export function isResultRevealed(): boolean {
  const r = getRow()
  return (r.status === 'final' || r.status === 'ended') && !!r.final_step && STEP_ORDER.indexOf(r.final_step) >= STEP_ORDER.indexOf('result')
}

export function getFinalState(): FinalState | null {
  const r = getRow()
  if ((r.status !== 'final' && r.status !== 'ended') || !r.final_step) return null
  const progress = finalVoteProgress()
  const closed = r.votes_closed === 1
  const t = closed ? tally() : null
  return {
    step: r.final_step,
    votes: { done: progress.reduce((s, p) => s + p.done, 0), eligible: progress.reduce((s, p) => s + p.eligible, 0) },
    closed,
    tally: t,
    tieUnresolved: !!t && t.gem === t.gold && !r.adopted,
    tiebreak: r.tiebreak,
    adopted: closed ? r.adopted : null,
    lastIssue: isResultRevealed() ? lastRoundAmounts(r.total_days ?? r.day) : null,
    spies: r.final_step === 'spy' ? listSpyStatus() : null,
  }
}

/** 게임 시작·리셋 때 */
export function clearFinalVotes() {
  db.prepare('DELETE FROM final_votes').run()
}
