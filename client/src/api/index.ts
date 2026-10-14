import axios from 'axios';
import type { AuthUser, Card, Goal, Transaction, RiseupStatus, RiseupSyncResult } from '../types';

// Same-origin: the session is an HttpOnly cookie, so no withCredentials and no token handling here.
export const api = axios.create({ baseURL: '/api' });

let onUnauthorized: (() => void) | null = null;
/** AuthProvider registers this so a 401 from any data request drops the app to the login screen. */
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const url = String(error?.config?.url ?? '');
    // /auth/* 401s are expected (bad password, anonymous /me) and handled by their callers.
    if (error?.response?.status === 401 && !url.startsWith('/auth/')) onUnauthorized?.();
    return Promise.reject(error);
  },
);

export const authApi = {
  me: () => api.get<AuthUser>('/auth/me').then(r => r.data),
  login: (data: { email: string; password: string }) => api.post<AuthUser>('/auth/login', data).then(r => r.data),
  register: (data: { email: string; password: string }) => api.post<AuthUser>('/auth/register', data).then(r => r.data),
  logout: () => api.post<{ ok: boolean }>('/auth/logout').then(r => r.data),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    api.post<{ ok: boolean }>('/auth/change-password', data).then(r => r.data),
};

export const cardsApi = {
  list: () => api.get<Card[]>('/cards').then(r => r.data),
  create: (data: Partial<Card>) => api.post<{ id: string }>('/cards', data).then(r => r.data),
  update: (id: string, data: Partial<Card>) => api.put(`/cards/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/cards/${id}`).then(r => r.data),
};

export const goalsApi = {
  list: (card_id?: string) =>
    api.get<Goal[]>('/goals', { params: card_id ? { card_id } : {} }).then(r => r.data),
  create: (data: Partial<Goal>) => api.post<{ id: string }>('/goals', data).then(r => r.data),
  update: (id: string, data: Partial<Goal>) => api.put(`/goals/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/goals/${id}`).then(r => r.data),
};

export const transactionsApi = {
  list: (params?: { card_id?: string; from?: string; to?: string; limit?: number }) =>
    api.get<Transaction[]>('/transactions', { params }).then(r => r.data),
  create: (data: Partial<Transaction>) =>
    api.post<{ id: string }>('/transactions', data).then(r => r.data),
  // card_id disambiguates synced rows whose RiseUp transaction id could exist under several cards.
  delete: (id: string, card_id: string) =>
    api.delete(`/transactions/${id}`, { params: { card_id } }).then(r => r.data),
};

export const riseupApi = {
  status: () => api.get<RiseupStatus>('/riseup/status').then(r => r.data),
  connect: (token: string) => api.put('/riseup/token', { token }).then(r => r.data),
  disconnect: () => api.delete('/riseup/token').then(r => r.data),
  sync: (months?: number, force = true) => api.post<RiseupSyncResult>('/riseup/sync', { months, force }).then(r => r.data),
};
