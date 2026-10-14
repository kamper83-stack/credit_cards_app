import { type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../api';
import { AuthProvider } from '../auth/AuthContext';

export interface Reply { status: number; data?: unknown; headers?: Record<string, string> }
export type Handler = (method: string, url: string, cfg: InternalAxiosRequestConfig) => Reply;

export const user = { id: 'u1', email: 'a@example.com', isAdmin: false };

/** Replaces axios' network layer; records every request as "METHOD /url". */
export function mockApi(handler: Handler) {
  const calls: string[] = [];
  api.defaults.adapter = async (cfg) => {
    const method = (cfg.method ?? 'get').toUpperCase();
    const url = cfg.url ?? '';
    calls.push(`${method} ${url}`);
    const r = handler(method, url, cfg);
    const response = { status: r.status, statusText: '', data: r.data ?? {}, headers: r.headers ?? {}, config: cfg };
    if (r.status >= 200 && r.status < 300) return response;
    throw new AxiosError(`HTTP ${r.status}`, 'ERR_BAD_REQUEST', cfg, null, response);
  };
  return calls;
}

export function renderApp(ui: ReactElement, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}
