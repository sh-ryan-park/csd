import { createRouter, createWebHistory } from 'vue-router'
import type { Role } from '../../../shared/types'
import { useAuthStore } from '../stores/auth'

declare module 'vue-router' {
  interface RouteMeta { roles?: Role[]; public?: boolean }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: () => useAuthStore().homePath },
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/admin', component: () => import('../views/AdminView.vue'), meta: { roles: ['admin'] } },
    { path: '/prizes', component: () => import('../views/PrizeView.vue'), meta: { roles: ['admin'] } },
    { path: '/present', component: () => import('../views/PresentView.vue'), meta: { roles: ['presenter', 'admin'] } },
    { path: '/group', component: () => import('../views/GroupView.vue'), meta: { roles: ['member'] } },
    { path: '/rules', component: () => import('../views/RulesView.vue') },
    { path: '/sound', component: () => import('../views/SoundView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  // 새로고침 직후에는 refresh 쿠키로 재로그인이 끝날 때까지 기다린다 (안 기다리면 항상 /login 으로 튕김)
  if (!auth.ready) await auth.bootstrap()
  if (to.meta.public) return auth.isLoggedIn ? auth.homePath : true
  if (!auth.isLoggedIn) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.meta.roles && !to.meta.roles.includes(auth.user!.role)) return auth.homePath
  return true
})
