import axios from 'axios';
import type { Card, Goal, Transaction, RiseupStatus, RiseupSyncResult } from '../types';

const api = axios.create({ baseURL: '/api' });

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
  delete: (id: string) => api.delete(`/transactions/${id}`).then(r => r.data),
};

export const riseupApi = {
  status: () => api.get<RiseupStatus>('/riseup/status').then(r => r.data),
  connect: (token: string) => api.put('/riseup/token', { token }).then(r => r.data),
  disconnect: () => api.delete('/riseup/token').then(r => r.data),
  sync: (months?: number) => api.post<RiseupSyncResult>('/riseup/sync', { months }).then(r => r.data),
};
