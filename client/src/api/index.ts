import axios from 'axios';
import type { Card, Goal, Transaction, Provider } from '../types';

const api = axios.create({ baseURL: '/api' });

export const cardsApi = {
  list: () => api.get<Card[]>('/cards').then(r => r.data),
  create: (data: Partial<Card> & { credentials?: Record<string, string> }) =>
    api.post<{ id: string }>('/cards', data).then(r => r.data),
  update: (id: string, data: Partial<Card> & { credentials?: Record<string, string> }) =>
    api.put(`/cards/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/cards/${id}`).then(r => r.data),
  sync: (id: string) => api.post<{ count: number }>(`/cards/${id}/sync`).then(r => r.data),
  providers: () => api.get<Provider[]>('/cards/providers').then(r => r.data),
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
