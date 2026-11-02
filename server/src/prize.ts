/**
 * 상금 계산 (관리자 화면 /prizes). 정산 결과로 분배 방식마다 등수별 인별 금액·팀 총합을 한 번에 낸다.
 * 금액·비율·규칙 문구는 서버에만 둔다. 클라이언트 파일은 로그인 없이 받을 수 있어 거기 두면 참가자가 미리 볼 수 있다.
 *
 * 등수: 보상 비율이 있는 생존 팀이 비율 순으로 1·2·3등, 생존했지만 비율이 0 인 팀(상대 화폐 발행팀 등)이 4등. 살아남은 사람이 없는 팀은 칸이 없다.
 * 금액: 인별 금액은 PRIZE_UNIT 미만 버림, 팀 총합 = 인별 금액 × 인원, 잔액 = 총액 − 팀 총합의 합.
 */
import { josa } from '../../shared/game.js'
import type { PrizeCell, PrizeColumn, PrizePlan, TeamShare } from '../../shared/game.js'

export const PRIZE_TOTAL = 1_000_000
/** 인별 금액 단위 */
export const PRIZE_UNIT = 1_000
/** 팀 고정 금액: 1·2·3·4등 팀과 탈락자 전체가 받는 금액 */
const POTS = [330_000, 270_000, 200_000, 130_000, 70_000]
/** 고정 인별 금액 */
const DEAD = 10_000
const FOUR = 20_000
/** 1·2·3·4등·탈락 비율 */
const WEIGHTS = [5, 4, 3, 2, 1]
/** 역전 방지: 바로 아래 등수보다 이 배수 이상 */
const MARGIN = 1.1
/** 역전 방지 계산 단위. 처음부터 PRIZE_UNIT 로 쌓으면 아래 등수를 한 단위 올릴 때 위 등수가 줄줄이 올라 총액을 못 채우고 잔액이 크게 남는다 */
const LADDER_UNIT = 10

// 1e-6: 나눗셈 오차로 정확히 단위 배수인 금액이 한 단위 어긋나지 않게 한다
const floorTo = (unit: number, won: number) => Math.floor((won + 1e-6) / unit) * unit
const ceilTo = (unit: number, won: number) => Math.ceil((won - 1e-6) / unit) * unit
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** col = columns 번호. tier = 0~3 은 1~4등, 4 는 탈락 */
interface Row { col: number; tier: number; people: number; each: number; total: number }
interface Payee { col: number; n: number; hold: number }
interface Field { pos: Payee[]; last: Payee[]; dead: number; deadCol: number }
interface Outcome { rows: Row[] | null; note: string }

const paid = (rows: Row[]) => sum(rows.map((r) => r.total))
function entry(col: number, tier: number, people: number, exact: number): Row {
  const each = floorTo(PRIZE_UNIT, exact)
  return { col, tier, people, each, total: each * people }
}

function fixedTeam({ pos, last, dead, deadCol }: Field): Outcome {
  return {
    rows: [
      ...pos.map((t, i) => entry(t.col, i, t.n, POTS[i] / t.n)),
      ...last.map((t) => entry(t.col, 3, t.n, POTS[3] / t.n)),
      ...(dead ? [entry(deadCol, 4, dead, POTS[4] / dead)] : []),
    ],
    note: dead ? '' : '탈락 몫은 잔액',
  }
}

function fixedPlusHolding({ pos, last, dead, deadCol }: Field): Outcome {
  const rest = PRIZE_TOTAL - DEAD * dead - FOUR * sum(last.map((t) => t.n))
  const tot = sum(pos.map((t) => t.hold))
  if (!(tot > 0)) return { rows: null, note: '보유량이 있는 팀 없음' }
  if (rest < 0) return { rows: null, note: '고정 금액이 총액 초과' }
  return {
    rows: [
      ...pos.map((t, i) => entry(t.col, i, t.n, (rest * t.hold) / tot / t.n)),
      ...last.map((t) => entry(t.col, 3, t.n, FOUR)),
      ...(dead ? [entry(deadCol, 4, dead, DEAD)] : []),
    ],
    note: '',
  }
}

function perPersonRatio({ pos, last, dead, deadCol }: Field): Outcome {
  const units = sum(pos.map((t, i) => WEIGHTS[i] * t.n)) + sum(last.map((t) => WEIGHTS[3] * t.n)) + WEIGHTS[4] * dead
  const k = PRIZE_TOTAL / units
  return {
    rows: [
      ...pos.map((t, i) => entry(t.col, i, t.n, WEIGHTS[i] * k)),
      ...last.map((t) => entry(t.col, 3, t.n, WEIGHTS[3] * k)),
      ...(dead ? [entry(deadCol, 4, dead, WEIGHTS[4] * k)] : []),
    ],
    note: '',
  }
}

function teamRatio({ pos, last, dead, deadCol }: Field): Outcome {
  const rest = PRIZE_TOTAL - DEAD * dead
  const weight = sum(pos.map((_, i) => WEIGHTS[i])) + WEIGHTS[3] * last.length
  if (rest < 0) return { rows: null, note: '고정 금액이 총액 초과' }
  const unit = weight ? rest / weight : 0
  return {
    rows: [
      ...pos.map((t, i) => entry(t.col, i, t.n, (WEIGHTS[i] * unit) / t.n)),
      ...last.map((t) => entry(t.col, 3, t.n, (WEIGHTS[3] * unit) / t.n)),
      ...(dead ? [entry(deadCol, 4, dead, DEAD)] : []),
    ],
    note: '',
  }
}

function noInversion({ pos, last, dead, deadCol }: Field): Outcome {
  const fine = (won: number) => floorTo(LADDER_UNIT, won)
  const fineUp = (won: number) => ceilTo(LADDER_UNIT, won)
  const settled = (rows: Row[]) => rows.map((r) => entry(r.col, r.tier, r.people, r.each))
  const tiers = [
    ...pos.map((t, i) => ({ weight: WEIGHTS[i], tier: i, teams: [t] })),
    ...(last.length ? [{ weight: WEIGHTS[3], tier: 3, teams: last }] : []),
  ].reverse()
  // 아래 등수부터 쌓는다. 인별 금액은 기본 금액 이상, 바로 아래 인별 금액과 팀 총합보다 MARGIN 배 이상
  const build = (u: number, deadEach: number): Row[] => {
    const rows: Row[] = []
    let prevEach = deadEach
    let prevTotal = 0
    for (const { weight, tier, teams } of tiers) {
      const small = Math.min(...teams.map((t) => t.n))
      const each = Math.max(fine(weight * u), fineUp(prevEach * MARGIN), fineUp((prevTotal * MARGIN) / small))
      for (const t of teams) rows.push({ col: t.col, tier, people: t.n, each, total: each * t.n })
      prevEach = each
      prevTotal = each * Math.max(...teams.map((t) => t.n))
    }
    if (dead) rows.push({ col: deadCol, tier: 4, people: dead, each: deadEach, total: deadEach * dead })
    return rows
  }
  // 총액을 넘지 않는 가장 큰 1단위. 1단위가 0 이어도 넘으면 탈락 금액을 낮춘다
  if (paid(build(0, DEAD)) > PRIZE_TOTAL) {
    let lo = 0
    let hi = DEAD
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (paid(build(0, fine(mid))) <= PRIZE_TOTAL) lo = mid
      else hi = mid
    }
    return { rows: settled(build(0, fine(lo))), note: '탈락 금액 낮춤' }
  }
  let lo = 0
  let hi = PRIZE_TOTAL
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (paid(build(mid, DEAD)) <= PRIZE_TOTAL) lo = mid
    else hi = mid
  }
  return { rows: settled(build(lo, DEAD)), note: last.length > 0 && fine(WEIGHTS[3] * lo) < fineUp(DEAD * MARGIN) ? '4등 최저 금액 고정' : '' }
}

const PLANS: { name: string; rule: string; fn: (f: Field) => Outcome }[] = [
  {
    name: '팀 고정 금액',
    rule: '인원과 관계없이 1·2·3·4등 팀이 33만·27만·20만·13만 원을 받고, 탈락자 전체가 7만 원을 나눠요.',
    fn: fixedTeam,
  },
  {
    name: '탈락·4등 고정 + 보유량 비율',
    rule: '탈락 1인 1만 원, 4등 1인 2만 원을 먼저 주고, 나머지를 1·2·3등 팀이 채택 화폐 보유량 비율로 나눠요. 인원은 보지 않아요.',
    fn: fixedPlusHolding,
  },
  {
    name: '인별 5:4:3:2:1',
    rule: '1·2·3·4등·탈락의 인별 금액을 5:4:3:2:1 로 맞춰 총액을 나눠요.',
    fn: perPersonRatio,
  },
  {
    name: '탈락 고정 + 팀 5:4:3:2',
    rule: '탈락 1인 1만 원을 먼저 주고, 나머지를 1·2·3·4등 팀이 5:4:3:2 로 나눠요. 인원은 보지 않아요.',
    fn: teamRatio,
  },
  {
    name: '탈락 고정 + 역전 방지',
    rule: '탈락 1인 1만 원을 먼저 주고, 1·2·3·4등 인별 금액을 5:4:3:2 로 잡되 4등부터 위로 바로 아래 등수보다 인별 금액과 팀 총합이 모두 10% 이상 많게 올려 총액에 맞춰요. 총액이 모자라면 탈락 금액을 낮춰요. 마지막에 끝자리를 버리므로 차이가 10%보다 조금 작아질 수 있어요.',
    fn: noInversion,
  },
]

function toCells(rows: Row[]): PrizeCell[] {
  return [...rows].sort((a, b) => a.col - b.col).map((r) => ({
    each: r.each,
    total: r.total,
    eachFlip: rows.some((o) => o.tier < r.tier && r.each > o.each),
    totalFlip: r.tier < 4 && rows.some((o) => o.tier < r.tier && r.total > o.total),
  }))
}

/** rewards = 테러리스트 보상 합계. 상금 총액과 따로 나가므로 총 지출에만 더한다 */
export function computePrizes(teams: TeamShare[], dead: number, rewards: number): { columns: PrizeColumn[]; plans: PrizePlan[]; warnings: string[] } {
  const alive = teams.filter((t) => t.alive > 0)
  const held = alive.filter((t) => t.share > 0).sort((a, b) => b.share - a.share)
  const pos = held.slice(0, 3)
  const last = [...held.slice(3), ...alive.filter((t) => !(t.share > 0))]

  const columnOf = (label: string, t: TeamShare): PrizeColumn => ({ label, teamId: t.teamId, name: t.name, color: t.color, people: t.alive })
  const columns = [...pos.map((t, i) => columnOf(`${i + 1}등`, t)), ...last.map((t) => columnOf('4등', t))]
  const deadCol = columns.length
  if (dead) columns.push({ label: '탈락', teamId: null, name: '탈락자', color: '', people: dead })

  const payee = (t: TeamShare, col: number): Payee => ({ col, n: t.alive, hold: t.holding })
  const field: Field = { pos: pos.map((t, i) => payee(t, i)), last: last.map((t, i) => payee(t, pos.length + i)), dead, deadCol }
  const plans = PLANS.map(({ name, rule, fn }): PrizePlan => {
    const { rows, note } = fn(field)
    const left = rows && PRIZE_TOTAL - paid(rows)
    return { name, rule, note: left != null && left < 0 ? '총액 초과' : note, cells: rows && toCells(rows), left, spend: rows && paid(rows) + rewards }
  })

  const warnings: string[] = []
  for (const h of new Set(held.map((t) => t.holding))) {
    const tied = held.filter((t) => t.holding === h)
    if (tied.length > 1) warnings.push(`${tied.map((t) => t.name).join(' · ')}의 보유량이 ${h.toLocaleString('ko-KR')}개로 같아요. 팀 순서대로 위 등수에 두었으니 확인하세요.`)
  }
  for (const t of teams) {
    if (t.alive === 0) warnings.push(`${josa(t.name, '은/는')} 살아남은 사람이 없어 상금 칸에서 뺐어요.`)
  }
  return { columns, plans, warnings }
}
