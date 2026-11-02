/**
 * 테러리스트 (docs/100.최종룰_차이_결정사항.md N4, 룰 03 §12 · 05).
 *   준비 상태: 팀을 고른 참가자가 "운명의 카드" 천사/악마 중 하나를 고른다 (1회, 되돌릴 수 없음). 악마 = 테러리스트 후보.
 *   내부 값은 sun = 천사, moon = 악마 (2026-11-02 태양/달 → 천사/악마, 표시만 변경)
 *            관리자가 후보 중에서 테러리스트를 직접 지정한다 (무작위 없음, 인원 자유). 후보가 있으면 1명 이상 지정해야 시작
 *   게임 시작: 시작 순간 활성 참가자 명단을 game.start_roster 에 남긴다
 *   적립   : 명단 중 지금 비활성(탈락)인 사람 수 − 본인 × 5천 원, 최대 5만 원. 본인이 탈락하면 0.
 *            라이프 제출·자진 탈락·관리자 탈락 처리 모두 같다 (활성 여부로만 본다 → 관리자가 복귀시키면 다시 빠진다)
 *   최종장 ④: 관리자가 공개 (db/final.ts)
 * 대상은 활성 참가자 전원 (리더·테스트 계정 포함). 테러리스트 여부는 본인·관리자만 안다.
 */
import { db } from './index.js'
import { GameError } from './gameError.js'
import { spyReward } from '../../../shared/game.js'
import type { AdminSpyView, Fate, SpyStatus } from '../../../shared/game.js'

function status(): string {
  return (db.prepare('SELECT status FROM game WHERE id = 1').get() as { status: string }).status
}

/** 운명의 카드 선택. 준비 상태 · 팀을 고른 활성 참가자 · 1회 */
export function chooseFate(userId: number, fate: Fate) {
  if (status() !== 'ready') throw new GameError('not_ready', '게임 준비 중에만 고를 수 있어요')
  const u = db.prepare(`SELECT group_id FROM users WHERE id = ? AND role = 'member' AND active = 1`).get(userId) as { group_id: number | null } | undefined
  if (!u) throw new GameError('not_found', '', 404)
  if (u.group_id == null) throw new GameError('no_group', '팀을 먼저 고르세요', 400)
  const ok = db.prepare('INSERT OR IGNORE INTO fate_choices (user_id, fate) VALUES (?, ?)').run(userId, fate).changes === 1
  if (!ok) throw new GameError('already_chosen', '이미 카드를 골랐어요. 선택은 되돌릴 수 없어요')
}

export function getMyFate(userId: number): Fate | null {
  return (db.prepare('SELECT fate FROM fate_choices WHERE user_id = ?').get(userId) as { fate: Fate } | undefined)?.fate ?? null
}

/** 후보 = 악마(moon)를 고른, 팀이 있는 활성 참가자 */
function candidates(): AdminSpyView['candidates'] {
  return (db.prepare(
    `SELECT u.id, u.name, u.group_id, u.is_test FROM fate_choices f JOIN users u ON u.id = f.user_id
     WHERE f.fate = 'moon' AND u.role = 'member' AND u.active = 1 AND u.group_id IS NOT NULL ORDER BY u.group_id, u.id`,
  ).all() as { id: number; name: string; group_id: number; is_test: number }[]).map((r) => ({ userId: r.id, name: r.name, teamId: r.group_id, isTest: r.is_test === 1 }))
}

function selectedIds(): number[] {
  return (db.prepare('SELECT user_id FROM spies ORDER BY user_id').all() as { user_id: number }[]).map((r) => r.user_id)
}

/** 관리자 지정 (준비 상태). 후보 중에서만, 목록 전체를 바꾼다 */
export function setSpies(userIds: number[]) {
  db.transaction(() => {
    if (status() !== 'ready') throw new GameError('not_ready', '테러리스트는 게임 준비 중에만 지정할 수 있어요')
    const ok = new Set(candidates().map((c) => c.userId))
    const bad = userIds.filter((id) => !ok.has(id))
    if (bad.length) throw new GameError('not_candidate', '악마를 고른 후보 중에서만 지정할 수 있어요', 400)
    db.prepare('DELETE FROM spies').run()
    const ins = db.prepare('INSERT INTO spies (user_id) VALUES (?)')
    for (const id of new Set(userIds)) ins.run(id)
  })()
}

/**
 * 게임 시작 점검 (startGame 트랜잭션 안에서, 미배정 참가자를 비활성으로 바꾼 뒤).
 * 시작 때 비활성이 된 테러리스트는 지정에서 빼고, 후보가 있는데 지정된 테러리스트가 없으면 거부. 시작 명단을 남긴다
 */
export function prepareSpiesForStart(): void {
  db.prepare(`DELETE FROM spies WHERE user_id NOT IN (SELECT id FROM users WHERE role = 'member' AND active = 1 AND group_id IS NOT NULL)`).run()
  if (candidates().length > 0 && selectedIds().length === 0) {
    throw new GameError('no_spy', '악마를 고른 후보가 있어요. 테러리스트를 1명 이상 지정하세요')
  }
  const roster = (db.prepare(`SELECT id FROM users WHERE role = 'member' AND active = 1 AND group_id IS NOT NULL`).all() as { id: number }[]).map((r) => r.id)
  db.prepare('UPDATE game SET start_roster = ? WHERE id = 1').run(JSON.stringify(roster))
}

function startRoster(): number[] {
  const raw = (db.prepare('SELECT start_roster FROM game WHERE id = 1').get() as { start_roster: string | null }).start_roster
  return raw ? (JSON.parse(raw) as number[]) : []
}

/** 시작 이후 탈락자 수 = 시작 명단 중 지금 비활성인 사람 */
export function eliminatedCount(): number {
  const roster = startRoster()
  if (!roster.length) return 0
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE active != 1 AND id IN (${roster.map(() => '?').join(',')})`).get(...roster) as { n: number }).n
}

/** 테러리스트 현황 (시작 후). 탈락자 = 시작 명단 중 지금 비활성인 사람 (본인 제외) */
export function listSpyStatus(): SpyStatus[] {
  const roster = startRoster()
  if (!roster.length) return []
  const rows = db.prepare(`SELECT id, name, group_id, active FROM users WHERE id IN (${roster.map(() => '?').join(',')})`).all(...roster) as {
    id: number; name: string; group_id: number | null; active: number
  }[]
  const out = new Set(rows.filter((r) => r.active !== 1).map((r) => r.id))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return selectedIds().flatMap((id) => {
    const u = byId.get(id)
    if (!u) return []
    const alive = u.active === 1
    const eliminated = [...out].filter((x) => x !== id).length
    return [{ userId: id, name: u.name, teamId: u.group_id, alive, eliminated, reward: spyReward(eliminated, alive) }]
  })
}

/** 본인이 테러리스트면 현황 (게임 시작 후에만) */
export function getMySpy(userId: number): SpyStatus | null {
  return listSpyStatus().find((s) => s.userId === userId) ?? null
}

export function getAdminSpyView(): AdminSpyView {
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN f.fate = 'sun' THEN 1 ELSE 0 END) AS sun,
       SUM(CASE WHEN f.fate = 'moon' THEN 1 ELSE 0 END) AS moon,
       SUM(CASE WHEN f.fate IS NULL THEN 1 ELSE 0 END) AS none
     FROM users u LEFT JOIN fate_choices f ON f.user_id = u.id
     WHERE u.role = 'member' AND u.active = 1 AND u.group_id IS NOT NULL`,
  ).get() as { sun: number | null; moon: number | null; none: number | null }
  const s = status()
  return {
    counts: { sun: counts.sun ?? 0, moon: counts.moon ?? 0, none: counts.none ?? 0 },
    candidates: s === 'ready' ? candidates() : [],
    selected: selectedIds(),
    spies: s === 'running' || s === 'final' || s === 'ended' ? listSpyStatus() : [],
  }
}

/** 리셋 */
export function clearSpy() {
  db.prepare('DELETE FROM spies').run()
  db.prepare('DELETE FROM fate_choices').run()
  db.prepare('UPDATE game SET start_roster = NULL WHERE id = 1').run()
}
